import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { ObjectId } from "mongodb";


import { 
  getUsersCollection, 
  getOpportunitiesCollection, 
  getMasterSkillsCollection, 
  getMasterInterestsCollection 
} from "./db.js";
import { generatePersonalizedOpportunities, checkRateLimit, analyzeResumePdf } from "./gemini.server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "default_development_secret_do_not_use_in_prod";
const PORT = process.env.PORT || 8080;

function toObjectId(id) {
  const isValidHex = /^[0-9a-fA-F]{24}$/.test(id);
  if (isValidHex) {
    return new ObjectId(id);
  }
  return id;
}

const app = express();

// ── Performance: gzip all responses ──────────────────────────────────────────
app.use(compression());

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(cookieParser());

// ── Performance: cache static assets ─────────────────────────────────────────
// HTML pages: 10-minute cache (revalidate on stale)
// JS/CSS/images: 1-hour cache
const frontendPath = path.join(__dirname, "../../frontend");
app.use(express.static(frontendPath, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=60");
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600, immutable");
    }
  }
}));

// Authentication Middleware
function requireAuth(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token session" });
  }
}

// Soft Authentication Middleware (does not block, just extracts user if present)
function softAuth(req, res, next) {
  const token = req.cookies.auth_token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (err) {
      // Ignore invalid token
    }
  }
  next();
}

// ----------------------------------------------------------------------
// AUTH ENDPOINTS
// ----------------------------------------------------------------------

// Get Current Logged In User details
app.get("/api/auth/me", softAuth, async (req, res) => {
  if (!req.user) {
    return res.json(null);
  }
  return res.json({ userId: req.user.userId, name: req.user.name });
});

// Authenticate: Login or Signup dynamically
app.post("/api/auth/authenticate", async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: "Name and password required" });
  }

  try {
    const users = await getUsersCollection();
    let user = await users.findOne({ name });

    const DEFAULT_PROFILE = {
      name: "",
      avatar: "",
      field: "",
      interests: [],
      skills: [],
      categories: [],
      preferred_locations: [],
      future_you: ""
    };

    if (!user) {
      // Register new user
      const passwordHash = await bcrypt.hash(password, 10);
      const newUser = {
        name,
        passwordHash,
        createdAt: new Date(),
        profile: { ...DEFAULT_PROFILE, name },
        saved: [],
        interested: [],
        passed: [],
        applied: []
      };
      const result = await users.insertOne(newUser);
      user = { _id: result.insertedId, ...newUser };
    } else {
      // Validate password for existing user
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid password credentials" });
      }
    }

    const token = jwt.sign(
      { userId: user._id.toString(), name: user.name },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      path: "/",
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    });

    return res.json({ success: true, userId: user._id.toString() });
  } catch (error) {
    console.error("Auth error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("auth_token", {
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
  });
  return res.json({ success: true });
});

// -- PASSWORD RESET --
// Step 1: Verify identity (username + email on file)
app.post("/api/auth/reset/verify", async (req, res) => {
  const { username, email } = req.body;
  if (!username || !email) {
    return res.status(400).json({ error: "Username and email are required" });
  }
  try {
    const users = await getUsersCollection();
    const user = await users.findOne({ name: username });
    if (!user || (user.profile?.email || "").toLowerCase() !== email.toLowerCase()) {
      return res.status(404).json({ error: "No account found with that username and email combination" });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await users.updateOne(
      { _id: user._id },
      { $set: { resetCode: code, resetCodeExpires: expiresAt } }
    );
    return res.json({ success: true, code, message: "Identity verified" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Step 2: Confirm code + set new password
app.post("/api/auth/reset/confirm", async (req, res) => {
  const { username, code, newPassword } = req.body;
  if (!username || !code || !newPassword) {
    return res.status(400).json({ error: "Username, code, and new password are required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  try {
    const users = await getUsersCollection();
    const user = await users.findOne({ name: username });
    if (!user || user.resetCode !== code) {
      return res.status(400).json({ error: "Invalid reset code" });
    }
    if (!user.resetCodeExpires || new Date() > new Date(user.resetCodeExpires)) {
      return res.status(400).json({ error: "Reset code has expired. Please start over." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await users.updateOne(
      { _id: user._id },
      { $set: { passwordHash }, $unset: { resetCode: "", resetCodeExpires: "" } }
    );
    return res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ----------------------------------------------------------------------
// USER DATA ENDPOINTS (Require Authentication)
// ----------------------------------------------------------------------

// Helper to resolve MongoDB User instance
async function getDbUser(userIdStr) {
  const users = await getUsersCollection();
  const dbUser = await users.findOne({ _id: toObjectId(userIdStr) });
  if (!dbUser) throw new Error("User not found");
  return { users, dbUser };
}

// Fetch user profile (avatar excluded — fetch separately from /api/user/avatar)
app.get("/api/user/profile", requireAuth, async (req, res) => {
  try {
    const { dbUser } = await getDbUser(req.user.userId);
    const p = dbUser.profile || {};
    const profile = {
      name: p.name || "",
      field: p.field || "",
      interests: p.interests || [],
      skills: p.skills || [],
      categories: p.categories || [],
      preferred_locations: p.preferred_locations || [],
      future_you: p.future_you || "",
      bio: p.bio || "",
      university: p.university || "",
      year_of_study: p.year_of_study || "",
      goal: p.goal || "",
      email: p.email || "",
      portfolio_url: p.portfolio_url || "",
      github_url: p.github_url || "",
      leetcode_url: p.leetcode_url || "",
      // Return a boolean flag instead of the full base64 blob
      has_avatar: !!(p.avatar && p.avatar.length > 10),
    };
    // Short cache: 30s for profile data
    res.setHeader("Cache-Control", "private, max-age=30");
    return res.json({
      profile,
      saved: dbUser.saved || [],
      interested: dbUser.interested || [],
      passed: dbUser.passed || [],
      applied: dbUser.applied || []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Fetch avatar separately (heavy base64 blob — only loaded when needed)
app.get("/api/user/avatar", requireAuth, async (req, res) => {
  try {
    const { dbUser } = await getDbUser(req.user.userId);
    const avatar = dbUser.profile?.avatar || "";
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.json({ avatar });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ── SINGLE COMBINED INIT ENDPOINT ─────────�// each paying the cold-start penalty, there is only ONE.
app.get("/api/feed/init", requireAuth, async (req, res) => {
  try {
    const [usersCol, oppsCol] = await Promise.all([
      getUsersCollection(),
      getOpportunitiesCollection(),
    ]);

    // Fetch user first so we can use their profile for match scoring
    const dbUser = await usersCol.findOne({ _id: toObjectId(req.user.userId) });
    if (!dbUser) return res.status(404).json({ error: "User not found" });

    const p = dbUser.profile || {};

    // Build profile tokens (same logic as frontend getMatchScore)
    const profileTokens = [
      ...(p.skills || []),
      ...(p.interests || []),
      ...(p.categories || []),
      p.field
    ].filter(Boolean).map(t => t.toLowerCase());

    const now = new Date().toISOString();

    // Build aggregate pipeline with match scoring + descending sort
    const pipeline = [
      { $match: { deadline: { $gte: now } } }
    ];

    if (profileTokens.length > 0) {
      // Compute matchScore: fraction of opp tags that match profile tokens × 100
      pipeline.push({
        $addFields: {
          matchScore: {
            $cond: {
              if: { $gt: [{ $size: { $ifNull: ["$tags", []] } }, 0] },
              then: {
                $multiply: [
                  {
                    $divide: [
                      {
                        $size: {
                          $setIntersection: [
                            { $map: { input: { $ifNull: ["$tags", []] }, as: "t", in: { $toLower: "$$t" } } },
                            profileTokens
                          ]
                        }
                      },
                      { $size: { $ifNull: ["$tags", []] } }
                    ]
                  },
                  100
                ]
              },
              else: 0
            }
          }
        }
      });
      // Highest match first, then nearest deadline
      pipeline.push({ $sort: { matchScore: -1, deadline: 1 } });
    } else {
      // No profile set — sort by deadline
      pipeline.push({ $sort: { deadline: 1 } });
    }

    pipeline.push({ $limit: 50 }); // load more so swipe stack stays full
    pipeline.push({
      $project: {
        id: 1, _id: 1, title: 1, organization: 1, category: 1,
        location: 1, deadline: 1, tags: 1, prize_amount: 1,
        work_mode: 1, verified: 1, featured: 1, description: 1,
        apply_url: 1, participants: 1, application_start_date: 1,
        posted_at: 1, matchScore: 1
      }
    });

    // Run opportunities query in parallel with watchlist
    const oppsPromise = oppsCol.aggregate(pipeline).toArray();

    // Watchlist: upcoming deadlines from saved items
    const savedIds = dbUser.saved || [];
    const watchlistPromise = savedIds.length > 0
      ? oppsCol.find(
          { $or: [
              { id: { $in: savedIds } },
              { _id: { $in: savedIds.filter(id => /^[0-9a-fA-F]{24}$/.test(id)).map(id => toObjectId(id)) } }
            ],
            deadline: { $gte: now }
          },
          { projection: { title: 1, organization: 1, deadline: 1, id: 1, _id: 1 } }
        ).sort({ deadline: 1 }).limit(5).toArray()
      : Promise.resolve([]);

    const [opps, watchlistRaw] = await Promise.all([oppsPromise, watchlistPromise]);

    const results = opps.map(doc => ({
      ...doc,
      _id: String(doc._id),
      id: doc.id ? String(doc.id) : String(doc._id),
      matchScore: doc.matchScore !== undefined ? Math.round(doc.matchScore) : 0,
    }));

    const watchlist = watchlistRaw.map(d => ({
      ...d, _id: String(d._id), id: d.id ? String(d.id) : String(d._id)
    }));

    const profile = {
      name: p.name || "",
      field: p.field || "",
      interests: p.interests || [],
      skills: p.skills || [],
      categories: p.categories || [],
      preferred_locations: p.preferred_locations || [],
      future_you: p.future_you || "",
      goal: p.goal || "",
      has_avatar: !!(p.avatar && p.avatar.length > 10),
    };

    res.setHeader("Cache-Control", "private, max-age=15");
    return res.json({
      profile,
      saved: dbUser.saved || [],
      interested: dbUser.interested || [],
      passed: dbUser.passed || [],
      applied: dbUser.applied || [],
      opportunities: results,
      watchlist,
    });
  } catch (error) {
    console.error("feed/init error:", error);
    return res.status(500).json({ error: error.message });
  }
});
// Ping/keepwarm — lets frontend ping on load to pre-warm the function
app.get("/api/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));


// Update Profile
app.post("/api/user/profile", requireAuth, async (req, res) => {
  try {
    const { users } = await getDbUser(req.user.userId);
    const data = req.body;

    const updateQuery = Object.keys(data).reduce((acc, key) => {
      acc[`profile.${key}`] = data[key];
      return acc;
    }, {});

    await users.updateOne(
      { _id: toObjectId(req.user.userId) }, 
      { $set: updateQuery }
    );
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Toggle Saved status of an opportunity
app.post("/api/user/saved/toggle", requireAuth, async (req, res) => {
  try {
    const { users, dbUser } = await getDbUser(req.user.userId);
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Opportunity ID required" });

    const list = dbUser.saved || [];
    const isSaved = list.includes(id);

    if (isSaved) {
      await users.updateOne({ _id: toObjectId(req.user.userId) }, { $pull: { saved: id } });
    } else {
      await users.updateOne({ _id: toObjectId(req.user.userId) }, { $addToSet: { saved: id } });
    }
    return res.json({ success: true, saved: !isSaved });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Toggle Interested status (Like / Swipe Right)
app.post("/api/user/interested/toggle", requireAuth, async (req, res) => {
  try {
    const { users, dbUser } = await getDbUser(req.user.userId);
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Opportunity ID required" });

    const list = dbUser.interested || [];
    const isInterested = list.includes(id);

    if (isInterested) {
      await users.updateOne({ _id: toObjectId(req.user.userId) }, { $pull: { interested: id } });
    } else {
      await users.updateOne({ _id: toObjectId(req.user.userId) }, { $addToSet: { interested: id } });
    }
    return res.json({ success: true, interested: !isInterested });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Add to Passed (Swipe Left)
app.post("/api/user/passed/add", requireAuth, async (req, res) => {
  try {
    const { users } = await getDbUser(req.user.userId);
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Opportunity ID required" });

    await users.updateOne({ _id: toObjectId(req.user.userId) }, { $addToSet: { passed: id } });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Remove from Passed (Undo Swipe Left)
app.post("/api/user/passed/remove", requireAuth, async (req, res) => {
  try {
    const { users } = await getDbUser(req.user.userId);
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Opportunity ID required" });

    await users.updateOne({ _id: toObjectId(req.user.userId) }, { $pull: { passed: id } });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Toggle Applied status
app.post("/api/user/applied/toggle", requireAuth, async (req, res) => {
  try {
    const { users, dbUser } = await getDbUser(req.user.userId);
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "Opportunity ID required" });

    const list = dbUser.applied || [];
    const isApplied = list.includes(id);

    if (isApplied) {
      await users.updateOne({ _id: toObjectId(req.user.userId) }, { $pull: { applied: id } });
    } else {
      await users.updateOne({ _id: toObjectId(req.user.userId) }, { $addToSet: { applied: id } });
    }
    return res.json({ success: true, applied: !isApplied });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------
// OPPORTUNITIES ENDPOINTS
// ----------------------------------------------------------------------

// Fetch Opportunities with category, keyword search, profile matching, and pagination
app.post("/api/opportunities", async (req, res) => {
  try {
    const filters = req.body || {};
    const coll = await getOpportunitiesCollection();

    const pipeline = [];
    const match = {};

    if (filters.category && filters.category !== "all") match.category = filters.category;
    if (filters.tag) match.tags = filters.tag;
    if (filters.q) {
      match.$or = [
        { title: { $regex: filters.q, $options: "i" } },
        { organization: { $regex: filters.q, $options: "i" } },
        { tags: { $regex: filters.q, $options: "i" } }
      ];
    }

    // Only show future opportunities
    match.deadline = { $gte: new Date().toISOString() };

    if (Object.keys(match).length > 0) {
      pipeline.push({ $match: match });
    }

    if (filters.profileTokens && filters.profileTokens.length > 0) {
      pipeline.push({
        $addFields: {
          matchScore: {
            $cond: {
              if: { $gt: [{ $size: { $ifNull: ["$tags", []] } }, 0] },
              then: {
                $divide: [
                  {
                    $size: {
                      $setIntersection: [
                        { $map: { input: { $ifNull: ["$tags", []] }, as: "t", in: { $toLower: "$$t" } } },
                        filters.profileTokens.map((t) => t.toLowerCase())
                      ]
                    }
                  },
                  { $size: { $ifNull: ["$tags", []] } }
                ]
              },
              else: 0
            }
          }
        }
      });
      pipeline.push({ $sort: { matchScore: -1, deadline: 1 } });
    } else {
      pipeline.push({ $sort: { deadline: 1 } });
    }

    const page = filters.page || 1;
    const limit = filters.limit || 20;
    const skip = (page - 1) * limit;

    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });

    pipeline.push({
      $project: {
        id: 1,
        _id: 1,
        title: 1,
        organization: 1,
        category: 1,
        location: 1,
        deadline: 1,
        tags: 1,
        prize_amount: 1,
        work_mode: 1,
        verified: 1,
        featured: 1,
        description: 1,
        apply_url: 1,
        participants: 1,
        application_start_date: 1,
        posted_at: 1,
        matchScore: 1
      }
    });

    const docs = await coll.aggregate(pipeline).toArray();

    const results = docs.map((doc) => ({
      ...doc,
      _id: String(doc._id),
      id: doc.id ? String(doc.id) : String(doc._id),
    }));

    return res.json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Fetch ticker opportunities
app.get("/api/opportunities/ticker", async (req, res) => {
  try {
    const coll = await getOpportunitiesCollection();
    const docs = await coll
      .find({ deadline: { $gte: new Date().toISOString() } })
      .sort({ deadline: 1 })
      .limit(8)
      .toArray();

    const results = docs.map(doc => ({
      title: doc.title,
      organization: doc.organization,
      deadline: doc.deadline
    }));

    return res.json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Fetch list of opportunities by their array IDs
app.post("/api/opportunities/by-ids", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.json([]);
    }
    const coll = await getOpportunitiesCollection();
    const docs = await coll.find({ id: { $in: ids } }).toArray();

    const results = docs.map((doc) => ({
      ...doc,
      _id: String(doc._id),
      id: doc.id ? String(doc.id) : String(doc._id),
    }));

    return res.json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Fetch detailed opportunity page by ID
app.get("/api/opportunities/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const coll = await getOpportunitiesCollection();
    const doc = await coll.findOne({ id });
    if (!doc) {
      return res.status(404).json({ error: "Opportunity not found" });
    }
    return res.json({
      ...doc,
      _id: String(doc._id),
      id: doc.id ? String(doc.id) : String(doc._id),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------
// GEMINI / AI GENERATION ENDPOINTS
// ----------------------------------------------------------------------

// Generate personalized opportunities feed using Gemini
app.post("/api/gemini/generate", requireAuth, async (req, res) => {
  try {
    const { profile } = req.body;
    if (!profile) {
      return res.status(400).json({ error: "User profile required" });
    }

    const rateLimitIdentifier = profile.name || "anonymous";
    if (!checkRateLimit(rateLimitIdentifier)) {
      return res.status(429).json({ error: "Rate limit exceeded. Please wait a minute before trying again." });
    }

    const results = await generatePersonalizedOpportunities(profile);
    return res.json(results);
  } catch (error) {
    console.error("Gemini route error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Analyze base64 PDF resume using Gemini
app.post("/api/gemini/analyze-resume", requireAuth, async (req, res) => {
  try {
    const { base64Pdf } = req.body;
    if (!base64Pdf) {
      return res.status(400).json({ error: "base64Pdf required" });
    }

    if (!checkRateLimit("resume_upload")) {
      return res.status(429).json({ error: "Rate limit exceeded. Please wait a minute before trying again." });
    }

    const results = await analyzeResumePdf(base64Pdf);
    return res.json(results);
  } catch (error) {
    console.error("Gemini resume analysis route error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------
// MASTER DATA ENDPOINTS
// ----------------------------------------------------------------------

app.get("/api/master/skills", async (req, res) => {
  try {
    const coll = await getMasterSkillsCollection();
    const docs = await coll.find().toArray();
    return res.json(docs.map(d => d.name));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/master/interests", async (req, res) => {
  try {
    const coll = await getMasterInterestsCollection();
    const docs = await coll.find().toArray();
    return res.json(docs.map(d => d.name));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/master/skills", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Skill name required" });
    const coll = await getMasterSkillsCollection();
    await coll.insertOne({ name });
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 11000) return res.json({ success: true });
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/master/interests", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Interest name required" });
    const coll = await getMasterInterestsCollection();
    await coll.insertOne({ name });
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 11000) return res.json({ success: true });
    return res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------------------------
// STATIC FRONTEND ASSETS AND ROUTING
// ----------------------------------------------------------------------
// Note: express.static with cache headers is already set above.
// Route handlers below ensure SPA-style routing works correctly.

// Wildcard routing to serve HTML pages directly
app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/signup.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/login.html"));
});

app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/profile.html"));
});

app.get("/saved", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/saved.html"));
});

app.get("/calendar", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/calendar.html"));
});

app.get("/opportunity/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/opportunity.html"));
});

// Fallback to main index.html for root/other paths
app.get("*all", (req, res) => {
  res.sendFile(path.join(__dirname, "../../frontend/index.html"));
});

// Export for Vercel serverless — Vercel imports the default export
export default app;

// Local dev: start the server normally
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}


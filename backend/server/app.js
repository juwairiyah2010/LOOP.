import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
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

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(cookieParser());

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
  res.clearCookie("auth_token", { path: "/" });
  return res.json({ success: true });
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

// Fetch complete user profile data
app.get("/api/user/profile", requireAuth, async (req, res) => {
  try {
    const { dbUser } = await getDbUser(req.user.userId);
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
    return res.json({
      profile: { ...DEFAULT_PROFILE, ...(dbUser.profile || {}) },
      saved: dbUser.saved || [],
      interested: dbUser.interested || [],
      passed: dbUser.passed || [],
      applied: dbUser.applied || []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

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

// Serve static assets from frontend directory
app.use(express.static(path.join(__dirname, "../../frontend")));

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

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

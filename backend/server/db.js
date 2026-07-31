import dotenv from "dotenv";
dotenv.config({ override: true });
import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";
import { mockOpportunities } from "./mock-opportunities.js";

function sanitizeMongoUri(uri) {
  try {
    if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
      return uri;
    }
    const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)([^:]+):(.*)@([^/]+)(.*)$/);
    if (!match) return uri;
    const [_, scheme, username, password, host, rest] = match;
    const encodedUser = encodeURIComponent(username);
    const encodedPass = encodeURIComponent(password);
    return `${scheme}${encodedUser}:${encodedPass}@${host}${rest}`;
  } catch (err) {
    console.error("Failed to sanitize MONGODB_URI:", err);
    return uri;
  }
}

const rawUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const uri = sanitizeMongoUri(rawUri);
// Support both DATABASE_NAME and DATABASE env var names
const dbName = process.env.DATABASE_NAME || process.env.DATABASE || "leap_lounge";

// Serverless-optimized MongoDB connection options
const options = {
  maxPoolSize: 5,           // cap connections on serverless
  minPoolSize: 1,           // keep 1 alive to avoid reconnect on warm calls
  maxIdleTimeMS: 45000,     // keep idle connections 45s (Vercel max lifetime ~60s)
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 20000,
  connectTimeoutMS: 10000,
  retryWrites: true,
  retryReads: true,
  compressors: ["zlib"],    // compress wire traffic
};

let client;
let clientPromise;
let isMockDb = false;

let mockDbData = {
  opportunities: [],
  users: [],
  master_skills: [],
  master_interests: []
};

const mockDbFilePath = path.resolve(process.cwd(), "backend/server/mock-db.json");

function loadMockDb() {
  try {
    if (fs.existsSync(mockDbFilePath)) {
      mockDbData = JSON.parse(fs.readFileSync(mockDbFilePath, "utf8"));
      mockDbData.opportunities = mockDbData.opportunities || [];
      mockDbData.users = mockDbData.users || [];
      mockDbData.master_skills = mockDbData.master_skills || [];
      mockDbData.master_interests = mockDbData.master_interests || [];
    } else {
      // In-memory only (no file write — safe for read-only filesystems like Vercel)
      mockDbData.opportunities = mockOpportunities;
      mockDbData.master_skills = [
        { name: "React" }, { name: "Node.js" }, { name: "TypeScript" }, { name: "Python" }, { name: "UI/UX" }
      ];
      mockDbData.master_interests = [
        { name: "STEM" }, { name: "Business" }, { name: "AI" }, { name: "Sustainability" }, { name: "Leadership" }
      ];
    }
  } catch (err) {
    console.error("Failed to load mock DB:", err);
    // Fallback to in-memory defaults
    mockDbData.opportunities = mockOpportunities;
  }
}

function saveMockDb() {
  // Skip silently on read-only filesystems (Vercel, etc.)
  try {
    const dir = path.dirname(mockDbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(mockDbFilePath, JSON.stringify(mockDbData, null, 2), "utf8");
  } catch (err) {
    // Silently ignore — in production, MongoDB handles persistence
  }
}

// Generate simple string IDs for Mock DB
function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function matchQuery(item, query) {
  if (!query) return true;
  for (const [key, val] of Object.entries(query)) {
    if (key === "$or" && Array.isArray(val)) {
      const matched = val.some((subQuery) => {
        return Object.entries(subQuery).some(([field, matchVal]) => {
          const itemVal = item[field];
          if (matchVal && typeof matchVal === "object" && matchVal.$regex) {
            const regex = new RegExp(matchVal.$regex, matchVal.$options || "");
            if (Array.isArray(itemVal)) {
              return itemVal.some(v => regex.test(String(v)));
            }
            return regex.test(String(itemVal));
          }
          return String(itemVal) === String(matchVal);
        });
      });
      if (!matched) return false;
    } else if (key === "_id") {
      if (String(item._id) !== String(val)) return false;
    } else if (val && typeof val === "object") {
      const entryVal = item[key];
      if (val.$gte) {
        if (entryVal < val.$gte) return false;
      }
      if (val.$lte) {
        if (entryVal > val.$lte) return false;
      }
    } else {
      if (Array.isArray(item[key])) {
        if (!item[key].includes(val)) return false;
      } else if (String(item[key]) !== String(val)) {
        return false;
      }
    }
  }
  return true;
}

class MockCursor {
  constructor(results) {
    this.results = results;
  }

  sort(sortSpec) {
    const sortKeys = Object.entries(sortSpec);
    this.results.sort((a, b) => {
      for (const [key, direction] of sortKeys) {
        const dir = direction;
        const valA = a[key] !== undefined ? a[key] : 0;
        const valB = b[key] !== undefined ? b[key] : 0;
        if (valA !== valB) {
          return dir === -1 
            ? (valA < valB ? 1 : -1) 
            : (valA > valB ? 1 : -1);
        }
      }
      return 0;
    });
    return this;
  }

  limit(num) {
    this.results = this.results.slice(0, num);
    return this;
  }

  skip(num) {
    this.results = this.results.slice(num);
    return this;
  }

  async toArray() {
    return this.results;
  }
}

class MockCollection {
  constructor(name) {
    this.name = name;
  }

  get data() {
    const list = mockDbData[this.name] || [];
    return list.map(item => {
      if (item && typeof item === "object" && !item._id) {
        return { ...item, _id: item.id || generateId() };
      }
      return item;
    });
  }

  set data(newData) {
    mockDbData[this.name] = newData;
    saveMockDb();
  }

  find(query = {}) {
    let results = [...this.data];
    if (query && Object.keys(query).length > 0) {
      results = results.filter(item => matchQuery(item, query));
    }
    return new MockCursor(results);
  }

  async findOne(query = {}) {
    const results = this.data.filter(item => matchQuery(item, query));
    return results[0] || null;
  }

  async insertOne(doc) {
    const newDoc = { ...doc };
    if (!newDoc._id) {
      newDoc._id = generateId();
    }
    if (!newDoc.id && this.name === "opportunities") {
      newDoc.id = newDoc._id;
    }
    if (this.name === "users") {
      newDoc.saved = newDoc.saved || [];
      newDoc.interested = newDoc.interested || [];
      newDoc.passed = newDoc.passed || [];
      newDoc.applied = newDoc.applied || [];
    }
    const current = this.data;
    current.push(newDoc);
    this.data = current;
    return { insertedId: newDoc._id, acknowledged: true };
  }

  async insertMany(docs) {
    const inserted = docs.map(doc => {
      const newDoc = { ...doc };
      if (!newDoc._id) newDoc._id = generateId();
      return newDoc;
    });
    const current = this.data;
    current.push(...inserted);
    this.data = current;
    return { insertedCount: inserted.length, acknowledged: true };
  }

  async updateOne(filter, update) {
    const item = await this.findOne(filter);
    if (!item) return { matchedCount: 0, modifiedCount: 0 };
    
    if (update.$set) {
      Object.assign(item, update.$set);
    }
    if (update.$addToSet) {
      for (const [key, value] of Object.entries(update.$addToSet)) {
        if (!Array.isArray(item[key])) item[key] = [];
        if (!item[key].includes(value)) item[key].push(value);
      }
    }
    if (update.$pull) {
      for (const [key, value] of Object.entries(update.$pull)) {
        if (Array.isArray(item[key])) {
          item[key] = item[key].filter((v) => v !== value);
        }
      }
    }

    this.data = this.data.map(d => d._id === item._id ? item : d);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteMany(filter = {}) {
    this.data = [];
    return { deletedCount: this.data.length };
  }

  async createIndex(keys, options) {
    return "mock_index";
  }

  aggregate(pipeline) {
    let results = [...this.data];

    for (const stage of pipeline) {
      if (stage.$match) {
        results = results.filter(item => matchQuery(item, stage.$match));
      }
      if (stage.$addFields && stage.$addFields.matchScore) {
        for (const item of results) {
          const scoreExpr = stage.$addFields.matchScore;
          if (scoreExpr.$cond) {
            const tags = item.tags || [];
            const condition = scoreExpr.$cond;
            const profileTokens = condition.then?.$divide?.[0]?.$size?.$setIntersection?.[1];
            if (Array.isArray(profileTokens)) {
              const lowercaseProfileTokens = profileTokens.map(t => String(t).toLowerCase());
              const lowercaseTags = tags.map(t => String(t).toLowerCase());
              const intersection = lowercaseTags.filter(t => lowercaseProfileTokens.includes(t));
              item.matchScore = tags.length > 0 ? intersection.length / tags.length : 0;
            } else {
              item.matchScore = 0;
            }
          }
        }
      }
      if (stage.$sort) {
        const sortKeys = Object.entries(stage.$sort);
        results.sort((a, b) => {
          for (const [key, direction] of sortKeys) {
            const dir = direction;
            const valA = a[key] !== undefined ? a[key] : 0;
            const valB = b[key] !== undefined ? b[key] : 0;
            if (valA !== valB) {
              return dir === -1 
                ? (valA < valB ? 1 : -1) 
                : (valA > valB ? 1 : -1);
            }
          }
          return 0;
        });
      }
      if (stage.$skip) {
        results = results.slice(stage.$skip);
      }
      if (stage.$limit) {
        results = results.slice(0, stage.$limit);
      }
      if (stage.$project) {
        results = results.map(item => {
          const projected = {};
          for (const key of Object.keys(stage.$project)) {
            projected[key] = item[key];
          }
          return projected;
        });
      }
    }

    return {
      toArray: async () => results
    };
  }
}

// Serverless-safe MongoDB connection with global caching
// Vercel reuses warm function instances — reuse the same MongoClient
if (process.env.NODE_ENV !== "production") {
  // Development: force fresh check on every hot-reload
  delete global._mongoClientPromise;

  client = new MongoClient(uri, options);
  global._mongoClientPromise = client.connect().then((c) => {
    console.log("Connected to MongoDB (Dev)");
    setupIndexes(c.db(dbName)).catch(console.error);
    return c;
  }).catch(err => {
    console.warn("MongoDB Dev connection failed. Falling back to local Mock DB:", err.message);
    isMockDb = true;
    loadMockDb();
    return null;
  });
  clientPromise = global._mongoClientPromise;
} else {
  // Production (Vercel): reuse connection across warm invocations
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, options);
    global._mongoClientPromise = client.connect().then((c) => {
      console.log("Connected to MongoDB (Prod)");
      setupIndexes(c.db(dbName)).catch(console.error);
      return c;
    }).catch(err => {
      console.error("MongoDB Prod connection FAILED — check MONGODB_URI and Atlas Network Access (allow 0.0.0.0/0):", err.message);
      isMockDb = true;
      loadMockDb();
      return null;
    });
  }
  clientPromise = global._mongoClientPromise;
}

// Pre-init mock DB if the promise resolves to null
clientPromise.then(c => {
  if (!c) {
    isMockDb = true;
    loadMockDb();
  }
});

export async function getDb() {
  const connectedClient = await clientPromise;
  if (!connectedClient || isMockDb) {
    return null;
  }
  return connectedClient.db(dbName);
}

export async function getOpportunitiesCollection() {
  if (isMockDb) {
    return new MockCollection("opportunities");
  }
  const db = await getDb();
  if (!db) return new MockCollection("opportunities");
  return db.collection("opportunities");
}

export async function getUsersCollection() {
  if (isMockDb) {
    return new MockCollection("users");
  }
  const db = await getDb();
  if (!db) return new MockCollection("users");
  return db.collection("users");
}

export async function getMasterSkillsCollection() {
  if (isMockDb) {
    return new MockCollection("master_skills");
  }
  const db = await getDb();
  if (!db) return new MockCollection("master_skills");
  return db.collection("master_skills");
}

export async function getMasterInterestsCollection() {
  if (isMockDb) {
    return new MockCollection("master_interests");
  }
  const db = await getDb();
  if (!db) return new MockCollection("master_interests");
  return db.collection("master_interests");
}

async function setupIndexes(db) {
  try {
    const opps = db.collection("opportunities");
    await opps.createIndex(
      { title: "text", organization: "text", tags: "text" },
      { name: "search_text_idx" }
    );
    await opps.createIndex({ category: 1, deadline: 1 });
    await opps.createIndex({ deadline: 1 });
    await opps.createIndex({ location: 1 });
    await opps.createIndex({ application_start_date: 1 });
    await opps.createIndex({ tags: 1 });
    await opps.createIndex({ active: 1 });
    // Seed opportunities if empty
    const oppCount = await opps.countDocuments();
    if (oppCount === 0) {
      console.log("Seeding initial opportunities into MongoDB...");
      await opps.insertMany(mockOpportunities);
    }

    const mSkills = db.collection("master_skills");
    const skillCount = await mSkills.countDocuments();
    if (skillCount === 0) {
      console.log("Seeding initial master skills...");
      await mSkills.insertMany([
        { name: "React" }, { name: "Node.js" }, { name: "TypeScript" }, { name: "Python" }, { name: "UI/UX" }
      ]);
    }
    await mSkills.createIndex({ name: 1 }, { unique: true });

    const mInterests = db.collection("master_interests");
    const interestCount = await mInterests.countDocuments();
    if (interestCount === 0) {
      console.log("Seeding initial master interests...");
      await mInterests.insertMany([
        { name: "STEM" }, { name: "Business" }, { name: "AI" }, { name: "Sustainability" }, { name: "Leadership" }
      ]);
    }
    await mInterests.createIndex({ name: 1 }, { unique: true });

    console.log("MongoDB Indexes and Seeding ensured");
  } catch (error) {
    console.error("Failed to setup indexes and seed collections:", error);
  }
}

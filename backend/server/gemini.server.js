import dotenv from "dotenv";
dotenv.config({ override: true });
import { GoogleGenAI } from "@google/genai";
import { getOpportunitiesCollection } from "./db.js";

// Ensure the API key is available
const apiKey = process.env.GEMINI_API_KEY;
const isPlaceholderKey = !apiKey || apiKey === "your_gemini_api_key_here";

if (isPlaceholderKey) {
  console.warn("GEMINI_API_KEY environment variable is missing or placeholder. Running with local Mock Fallback system.");
}

// Initialize the GoogleGenAI SDK (will fail on calls if key is invalid, caught below)
export const ai = new GoogleGenAI({ apiKey: isPlaceholderKey ? "dummy_key_to_prevent_sdk_constructor_error" : apiKey });

// Rate Limiting Logic
const rateLimits = new Map();
const MAX_REQUESTS_PER_MINUTE = 5;

export function checkRateLimit(identifier) {
  const now = Date.now();
  const limitData = rateLimits.get(identifier);

  if (!limitData || limitData.resetTime < now) {
    rateLimits.set(identifier, { count: 1, resetTime: now + 60 * 1000 });
    return true;
  }

  if (limitData.count >= MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  limitData.count += 1;
  return true;
}

// ======================================================================
// LOCAL FALLBACK PARSER AND DATA DICTIONARIES
// ======================================================================

const PROGRAMMING_LANGUAGES = ["javascript", "typescript", "python", "java", "c++", "go", "rust", "swift", "kotlin", "sql"];
const FRAMEWORKS = ["react", "vue", "angular", "next.js", "node.js", "express", "django", "flask", "fastapi", "tailwind", "bootstrap"];
const TOOLS = ["figma", "sketch", "photoshop", "illustrator", "docker", "kubernetes", "git", "aws", "gcp", "azure"];
const TECHNOLOGIES = ["mongodb", "firebase", "supabase", "graphql", "rest", "machine learning", "deep learning", "ai", "nlp", "computer vision"];
const DOMAINS = ["ai", "web development", "cybersecurity", "finance", "design", "research", "product management", "startup"];
const SKILLS = ["agile", "testing", "ci/cd", "linux", "marketing", "seo", "copywriting", "strategy", "accounting", "sales", "leadership", "public speaking"];
const INTERESTS = ["stem", "business", "ai", "sustainability", "leadership", "open source", "photography", "writing", "music"];

function extractTextFromPdfBase64(base64Pdf) {
  try {
    const buffer = Buffer.from(base64Pdf, "base64");
    const str = buffer.toString("binary");
    const matches = str.match(/\(([^)]+)\)/g) || [];
    return matches.map(m => m.slice(1, -1)).join(" ");
  } catch (e) {
    console.error("Local PDF parsing failed:", e);
    return "";
  }
}

function analyzeResumeLocally(base64Pdf) {
  const text = extractTextFromPdfBase64(base64Pdf).toLowerCase();
  
  const matchedLangs = PROGRAMMING_LANGUAGES.filter(lang => text.includes(lang)).map(l => l.toUpperCase());
  const matchedFrameworks = FRAMEWORKS.filter(fw => text.includes(fw)).map(f => f.charAt(0).toUpperCase() + f.slice(1));
  const matchedTools = TOOLS.filter(tool => text.includes(tool)).map(t => t.charAt(0).toUpperCase() + t.slice(1));
  const matchedTechs = TECHNOLOGIES.filter(tech => text.includes(tech)).map(t => t.toUpperCase());
  const matchedDomains = DOMAINS.filter(domain => text.includes(domain)).map(d => d.charAt(0).toUpperCase() + d.slice(1));
  const matchedSkills = SKILLS.filter(skill => text.includes(skill)).map(s => s.charAt(0).toUpperCase() + s.slice(1));
  const matchedInterests = INTERESTS.filter(interest => text.includes(interest)).map(i => i.charAt(0).toUpperCase() + i.slice(1));

  const skills = Array.from(new Set([...matchedSkills, ...matchedLangs, ...matchedFrameworks]));
  const preferredRoles = [];
  if (text.includes("developer") || text.includes("engineer")) preferredRoles.push("Software Engineer");
  if (text.includes("designer") || text.includes("ui") || text.includes("ux")) preferredRoles.push("UI/UX Designer");
  if (text.includes("product") || text.includes("project")) preferredRoles.push("Product Manager");
  if (preferredRoles.length === 0) preferredRoles.push("Software Engineer");

  return {
    skills,
    interests: matchedInterests.length > 0 ? matchedInterests : ["STEM", "AI", "Open Source"],
    programmingLanguages: matchedLangs,
    frameworks: matchedFrameworks,
    tools: matchedTools,
    technologies: matchedTechs,
    domains: matchedDomains,
    preferredRoles
  };
}

const fieldOpportunities = {
  "Software Engineering": [
    {
      title: "Backend SWE Intern",
      organization: "Google",
      category: "internship",
      description: "Design and implement scalable backend services using Go, Java, or C++. Write clean, well-tested, and documentation-supported code.",
      location: "Mountain View, CA",
      prize_amount: null,
      tags: ["Go", "Backend", "SQL", "Docker", "Java"],
      apply_url: "https://google.com/about/careers",
      participants: 120,
      featured: true,
      work_mode: "hybrid",
      verified: true
    },
    {
      title: "Global Student Hackathon 2026",
      organization: "Major League Hacking",
      category: "hackathon",
      description: "Build innovative web and mobile apps over 48 hours. Compete with students globally for exciting prizes.",
      location: "Remote",
      prize_amount: "$10,000",
      tags: ["React", "Node.js", "MongoDB", "AI", "TypeScript"],
      apply_url: "https://mlh.io",
      participants: 850,
      featured: true,
      work_mode: "remote",
      verified: true
    },
    {
      title: "Open Source Fellowship",
      organization: "GitHub",
      category: "fellowship",
      description: "Contribute directly to major open-source web frameworks and tooling alongside senior maintainers.",
      location: "San Francisco, CA",
      prize_amount: "$8,000",
      tags: ["Git", "GitHub", "JavaScript", "TypeScript", "Node.js"],
      apply_url: "https://github.com",
      participants: 50,
      featured: true,
      work_mode: "remote",
      verified: true
    }
  ],
  "Design": [
    {
      title: "UI/UX Design Intern",
      organization: "Figma",
      category: "internship",
      description: "Design mockups, wireframes, and high-fidelity prototypes for next-generation design systems.",
      location: "San Francisco, CA",
      prize_amount: null,
      tags: ["Figma", "UI", "UX", "Product Design", "Branding"],
      apply_url: "https://figma.com/careers",
      participants: 80,
      featured: true,
      work_mode: "hybrid",
      verified: true
    },
    {
      title: "Creative Design Fellowship",
      organization: "Adobe",
      category: "fellowship",
      description: "Work with creative engineers to research spatial design interfaces, layout grids, and typography templates.",
      location: "New York, NY",
      prize_amount: "$6,000",
      tags: ["Figma", "Photoshop", "Illustrator", "UX", "Branding"],
      apply_url: "https://adobe.com",
      participants: 40,
      featured: true,
      work_mode: "hybrid",
      verified: true
    }
  ],
  "Data & AI": [
    {
      title: "Machine Learning Researcher",
      organization: "OpenAI",
      category: "fellowship",
      description: "Contribute to developing, optimizing, and training state-of-the-art Large Language Models and computer vision systems.",
      location: "San Francisco, CA",
      prize_amount: "$15,000",
      tags: ["Python", "PyTorch", "AI", "Machine Learning", "NLP"],
      apply_url: "https://openai.com",
      participants: 30,
      featured: true,
      work_mode: "onsite",
      verified: true
    },
    {
      title: "Data Science Intern",
      organization: "Netflix",
      category: "internship",
      description: "Analyze large-scale streaming patterns and metadata metrics to train personalized user recommendation algorithms.",
      location: "Los Gatos, CA",
      prize_amount: null,
      tags: ["Python", "SQL", "Statistics", "Data Science", "Analytics"],
      apply_url: "https://netflix.com",
      participants: 90,
      featured: true,
      work_mode: "hybrid",
      verified: true
    }
  ],
  "Product": [
    {
      title: "Associate Product Manager Intern",
      organization: "Uber",
      category: "internship",
      description: "Define product requirements, collaborate with design and engineering teams, and drive features from roadmap to release.",
      location: "San Francisco, CA",
      prize_amount: null,
      tags: ["Product Management", "Strategy", "Analytics", "Agile"],
      apply_url: "https://uber.com",
      participants: 45,
      featured: true,
      work_mode: "hybrid",
      verified: true
    }
  ],
  "Business": [
    {
      title: "Global Management Consultant",
      organization: "McKinsey & Company",
      category: "internship",
      description: "Help industry-leading clients solve complex operational issues, devise business strategies, and analyze market trends.",
      location: "New York, NY",
      prize_amount: null,
      tags: ["Consulting", "Strategy", "Finance", "Excel", "Leadership"],
      apply_url: "https://mckinsey.com",
      participants: 110,
      featured: true,
      work_mode: "onsite",
      verified: true
    }
  ],
  "Research": [
    {
      title: "Research Science Fellow",
      organization: "MIT Media Lab",
      category: "fellowship",
      description: "Conduct multidisciplinary academic research across hardware, design systems, and software engineering interfaces.",
      location: "Cambridge, MA",
      prize_amount: "$12,000",
      tags: ["Research", "Mathematics", "Physics", "Chemistry"],
      apply_url: "https://media.mit.edu",
      participants: 25,
      featured: true,
      work_mode: "onsite",
      verified: true
    }
  ],
  "default": [
    {
      title: "Student Leadership Fellowship",
      organization: "Leap Foundation",
      category: "fellowship",
      description: "A 6-month leadership accelerator program including mentoring, workshops, and grant opportunities.",
      location: "New York, NY",
      prize_amount: "$5,000",
      tags: ["Leadership", "Management", "Public Speaking", "Strategy"],
      apply_url: "https://leap.org/fellowship",
      participants: 150,
      featured: true,
      work_mode: "onsite",
      verified: true
    }
  ]
};

async function generateMockOpportunitiesLocally(userProfile) {
  const field = userProfile.field || "Software Engineering";
  const baseList = fieldOpportunities[field] || fieldOpportunities["default"];
  
  const results = baseList.map(opp => ({
    ...opp,
    id: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
    posted_at: new Date().toISOString(),
    deadline: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString() // 60 days in future
  }));

  // Insert into DB
  const coll = await getOpportunitiesCollection();
  await coll.insertMany(results);
  return results;
}

// ======================================================================
// GEMINI PUBLIC ROUTE EXPORTS WITH FALLBACKS
// ======================================================================

/**
 * Analyzes a list of opportunities against a user's profile.
 */
export async function analyzeOpportunities(userProfile, opportunityIds) {
  const coll = await getOpportunitiesCollection();

  if (opportunityIds && opportunityIds.length === 0) return [];

  const query = opportunityIds && opportunityIds.length > 0
    ? { id: { $in: opportunityIds } }
    : {};

  const docs = await coll.find(query).limit(50).toArray();
  const opportunities = docs.map((doc) => ({
    ...doc,
    _id: String(doc._id),
    id: doc.id ? String(doc.id) : String(doc._id),
  }));

  if (!opportunities.length) return [];

  if (isPlaceholderKey) {
    // Generate mock analysis report locally
    return opportunities.map((opp, index) => {
      const matchScoreVal = Math.min(100, Math.floor(Math.random() * 50) + 50); // 50 to 100
      return {
        opportunityId: opp.id,
        matchScore: matchScoreVal,
        recommendationReason: `Strong match with your profile. The project aligns with your field of study in ${userProfile.field}.`,
        missingSkills: opp.tags.slice(2, 4),
        priorityRanking: index + 1
      };
    }).sort((a,b) => b.matchScore - a.matchScore);
  }

  const prompt = `
    You are an AI career advisor. Evaluate the match between the user profile and the listed opportunities.

    USER PROFILE:
    Name: ${userProfile.name}
    Primary Field: ${userProfile.field}
    Interests/Categories: ${userProfile.interests.join(", ")}, ${userProfile.categories.join(", ")}
    Known Skills: ${userProfile.skills.join(", ")}

    OPPORTUNITIES:
    ${opportunities
      .map(
        (opp) => `
      - ID: ${opp.id}
      - Title: ${opp.title}
      - Organization: ${opp.organization}
      - Category: ${opp.category}
      - Tags: ${opp.tags.join(", ")}
      - Description: ${opp.description.substring(0, 500)}...
    `
      )
      .join("\n")}

    Return exactly a JSON array of objects. Each object MUST have the following keys:
    - "opportunityId" (string: the ID of the opportunity)
    - "matchScore" (number: 0-100 indicating how well the profile matches the opportunity)
    - "recommendationReason" (string: 1-2 sentences explaining why it's a good or bad match)
    - "missingSkills" (array of strings: skills the user doesn't have but are required/helpful)
    - "priorityRanking" (number: 1 for best match, 2 for second best, etc.)
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    let responseText = response.text;
    if (!responseText) throw new Error("No response from Gemini API");

    responseText = responseText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```\n?$/i, "").trim();

    const parsed = JSON.parse(responseText);
    return parsed.sort((a, b) => a.priorityRanking - b.priorityRanking);
  } catch (error) {
    console.error("Gemini Analysis Failed, using local fallback:", error.message);
    // Graceful Degradation: return local mocks
    return opportunities.map((opp, index) => {
      return {
        opportunityId: opp.id,
        matchScore: 85,
        recommendationReason: `Matched via offline algorithm. Highly matches your studies in ${userProfile.field}.`,
        missingSkills: [],
        priorityRanking: index + 1
      };
    });
  }
}

/**
 * Analyzes resume base64 PDF
 */
export async function analyzeResumePdf(base64Pdf) {
  if (isPlaceholderKey) {
    console.log("Gemini API key is placeholder. Analyzing resume locally...");
    return analyzeResumeLocally(base64Pdf);
  }

  const prompt = `
    Extract the following information from this resume and return exactly a JSON object.
    Do not include markdown blocks or any other text.
    Return ONLY a JSON object with these keys, all as arrays of strings:
    - "skills" (general professional skills)
    - "interests"
    - "programmingLanguages"
    - "frameworks"
    - "tools"
    - "technologies"
    - "domains" (e.g. AI, Web Development, Cybersecurity, Finance, etc.)
    - "preferredRoles" (e.g. Software Engineer, Product Manager, etc. inferred from past roles or summary)
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          inlineData: {
            data: base64Pdf,
            mimeType: "application/pdf",
          },
        },
        prompt,
      ],
      config: {
        responseMimeType: "application/json",
      },
    });

    let responseText = response.text;
    if (!responseText) throw new Error("No response from Gemini API");

    responseText = responseText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```\n?$/i, "").trim();

    const parsed = JSON.parse(responseText);
    return parsed;
  } catch (error) {
    console.error("Gemini Resume Analysis Failed, using local fallback:", error.message);
    return analyzeResumeLocally(base64Pdf);
  }
}

/**
 * Generate Personalized Feed
 */
export async function generatePersonalizedOpportunities(userProfile) {
  if (isPlaceholderKey) {
    console.log("Gemini API key is placeholder. Generating opportunities locally...");
    return generateMockOpportunitiesLocally(userProfile);
  }

  const prompt = `
    You are an AI that generates realistic and highly relevant opportunities (internships, jobs, hackathons, scholarships, fellowships) for students.
    Generate a JSON array containing 5 unique, realistic opportunities tailored for the following user profile.
    Make sure they sound like real programs (e.g., Google SWE Intern, MLH Hackathon, Stanford AI Fellowship, etc.).

    USER PROFILE:
    Name: ${userProfile.name}
    Primary Field: ${userProfile.field}
    Interests: ${userProfile.interests.join(", ")}
    Skills: ${userProfile.skills.join(", ")}
    Preferred Locations: ${userProfile.preferred_locations?.join(", ") || "Remote"}

    Return exactly a JSON array of objects. Each object MUST have the following keys:
    - "id" (string: a unique uuid-like string)
    - "title" (string: name of the opportunity)
    - "organization" (string: company or organization name)
    - "category" (string: must be one of "internship", "scholarship", "competition", "fellowship", "hackathon")
    - "description" (string: 2-3 sentences describing the role/program)
    - "location" (string: city, country or "Remote")
    - "deadline" (string: an ISO date string in the future, e.g. "2026-12-31T23:59:59Z")
    - "prize_amount" (string or null: e.g. "$5000" or null if not applicable)
    - "tags" (array of strings: relevant skills and domain tags)
    - "apply_url" (string: e.g., "https://example.com/apply")
    - "participants" (number: estimated participants, e.g. 100)
    - "featured" (boolean: true)
    - "posted_at" (string: current ISO date string)
    - "work_mode" (string: "remote", "hybrid", or "onsite")
    - "verified" (boolean: true)
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    let responseText = response.text;
    if (!responseText) throw new Error("No response from Gemini API");

    responseText = responseText.replace(/^```(?:json)?\n?/i, "").replace(/\n?```\n?$/i, "").trim();

    const parsed = JSON.parse(responseText);
    
    // Insert into DB
    const coll = await getOpportunitiesCollection();
    
    const docsToInsert = parsed.map(opp => {
       const newDoc = { ...opp };
       delete newDoc._id;
       return newDoc;
    });

    if (docsToInsert.length > 0) {
      await coll.insertMany(docsToInsert);
    }
    
    return parsed;
  } catch (error) {
    console.error("Gemini Generation Failed, using local fallback:", error.message);
    return generateMockOpportunitiesLocally(userProfile);
  }
}

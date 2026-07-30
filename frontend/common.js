// Common utilities for LOOP website

// Fetch current user auth state
async function getAuthUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Auth check failed:", err);
    return null;
  }
}

// Redirect if not logged in
async function requireAuth() {
  const user = await getAuthUser();
  if (!user) {
    window.location.href = "/signup";
    return null;
  }
  return user;
}

// Format deadlines into relative days remaining
function formatDeadline(deadlineStr) {
  const diffTime = new Date(deadlineStr) - new Date();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "Closed";
  if (diffDays === 0) return "Closes today";
  if (diffDays === 1) return "1 day left";
  return `${diffDays} days left`;
}

// Compute matching score based on user profile and opportunity tags
function getMatchScore(profile, tags) {
  if (!tags || tags.length === 0) return 0;
  const profileTokens = new Set([
    ...(profile.skills || []),
    ...(profile.interests || []),
    profile.field
  ].filter(Boolean).map(t => t.toLowerCase()));

  const matched = tags.filter(t => profileTokens.has(t.toLowerCase()));
  return Math.round((matched.length / tags.length) * 100);
}

// Fetch list of autocomplete options for skills/interests
async function fetchMasterList(type) {
  try {
    const res = await fetch(`/api/master/${type}`);
    if (res.ok) return await res.json();
  } catch (err) {
    console.error(`Failed to fetch master ${type}:`, err);
  }
  return [];
}

// Render dynamic header based on authentication status
function renderHeader(user) {
  const headerNav = document.getElementById("header-nav");
  if (!headerNav) return;

  if (user) {
    headerNav.innerHTML = `
      <div class="flex items-center gap-6">
        <a href="/" class="font-mono text-[11px] font-bold uppercase tracking-tight text-foreground/70 hover:text-foreground transition-all">Feed</a>
        <a href="/calendar" class="font-mono text-[11px] font-bold uppercase tracking-tight text-foreground/70 hover:text-foreground transition-all">Calendar</a>
        <a href="/saved" class="font-mono text-[11px] font-bold uppercase tracking-tight text-foreground/70 hover:text-foreground transition-all">Saved</a>
        <a href="/profile" class="font-mono text-[11px] font-bold uppercase tracking-tight text-foreground/70 hover:text-foreground transition-all">Profile</a>
        <button id="logout-btn" class="px-4 py-2 border-2 border-foreground rounded-full font-mono text-[11px] font-bold uppercase tracking-tight hover:bg-foreground hover:text-background transition-all">Log Out</button>
      </div>
    `;
    document.getElementById("logout-btn")?.addEventListener("click", async () => {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        window.location.href = "/";
      }
    });
  } else {
    headerNav.innerHTML = `
      <a href="/login" class="px-4 py-2 rounded-full font-mono text-[11px] font-bold uppercase tracking-tight text-foreground/70 hover:text-foreground hover:bg-foreground/5 transition-all">Log In</a>
      <a href="/signup" class="px-4 py-2 rounded-full font-mono text-[11px] font-bold uppercase tracking-tight bg-foreground text-background hover:bg-primary transition-colors">Sign Up</a>
    `;
  }
}

// Run dynamic marquee ticker data
async function initMarqueeTicker() {
  const marqueeContainer = document.getElementById("marquee-ticker");
  if (!marqueeContainer) return;

  try {
    const res = await fetch("/api/opportunities/ticker");
    if (!res.ok) return;
    const items = await res.json();
    
    if (items.length === 0) return;

    // Duplicate list items to create infinite scroll effect
    const tickerList = [...items, ...items];
    marqueeContainer.innerHTML = tickerList.map(item => {
      const daysLeft = formatDeadline(item.deadline);
      return `
        <span class="inline-flex items-center gap-3">
          <span>${item.title} · ${item.organization}</span>
          <span class="opacity-60">${daysLeft}</span>
          <span class="opacity-50">✦</span>
        </span>
      `;
    }).join("");
  } catch (err) {
    console.error("Failed to load ticker:", err);
  }
}

// Lucide icon generation
document.addEventListener("DOMContentLoaded", () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }
});

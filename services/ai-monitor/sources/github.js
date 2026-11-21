const AI_TOPICS = [
  "machine-learning",
  "deep-learning",
  "artificial-intelligence",
  "llm",
  "generative-ai",
];

const AI_KEYWORDS =
  /\b(llm|gpt|transformer|diffusion|neural|ml|ai|machine.learning|deep.learning|vision|nlp|agent|rag|fine.?tun)/i;

async function fetchTrending() {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const results = new Map();

  // GitHub Search API — topic-based queries
  for (const topic of AI_TOPICS) {
    const q = `topic:${topic} created:>${oneWeekAgo} stars:>50`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=20`;

    try {
      const res = await fetch(url, { headers });
      if (res.status === 403 || res.status === 429) {
        console.warn(`[github] Rate limited on topic ${topic}, skipping rest`);
        break;
      }
      if (!res.ok) continue;

      const data = await res.json();
      for (const repo of data.items || []) {
        if (results.has(repo.full_name)) continue;
        results.set(repo.full_name, {
          source: "github",
          id: `gh:${repo.full_name}`,
          title: repo.full_name,
          description: repo.description || "",
          link: repo.html_url,
          metadata: {
            stars: repo.stargazers_count,
            forks: repo.forks_count,
            language: repo.language,
            topics: repo.topics || [],
            created: repo.created_at,
          },
        });
      }
    } catch (e) {
      console.warn(`[github] Error fetching topic ${topic}:`, e.message);
    }

    // Rate limit spacing: ~2.5s between requests
    await new Promise((r) => setTimeout(r, 2500));
  }

  // OSS Insight — composite trending score
  try {
    const res = await fetch(
      "https://api.ossinsight.io/v1/trending-repos?period=past_24_hours&language=Python"
    );
    if (res.ok) {
      const data = await res.json();
      for (const repo of data.data?.rows || []) {
        const name = repo.repo_name;
        if (!name || results.has(name)) continue;
        if (!AI_KEYWORDS.test(repo.description || "")) continue;
        results.set(name, {
          source: "github",
          id: `gh:${name}`,
          title: name,
          description: repo.description || "",
          link: `https://github.com/${name}`,
          metadata: {
            stars: repo.stars || 0,
            forks: repo.forks || 0,
            language: repo.primary_language || "Python",
            ossInsightScore: repo.total_score,
          },
        });
      }
    }
  } catch (e) {
    console.warn("[github] OSS Insight error:", e.message);
  }

  return [...results.values()].sort(
    (a, b) => (b.metadata.stars || 0) - (a.metadata.stars || 0)
  );
}

module.exports = { fetchTrending };

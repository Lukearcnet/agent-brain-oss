const HF_API = "https://huggingface.co/api";

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HuggingFace ${res.status}: ${url}`);
  return res.json();
}

async function fetchTrending() {
  const [trending, dailyPapers, trendingModels] = await Promise.all([
    fetchJSON(`${HF_API}/trending`).catch(() => ({ recentlyTrending: [] })),
    fetchJSON(`${HF_API}/daily_papers?limit=15`).catch(() => []),
    fetchJSON(
      `${HF_API}/models?sort=trendingScore&direction=-1&limit=20&full=true`
    ).catch(() => []),
  ]);

  const items = [];

  // Trending models/spaces from homepage (skip datasets)
  for (const entry of trending.recentlyTrending || []) {
    if (entry.repoType === "dataset") continue;
    const d = entry.repoData || {};
    if ((d.trendingScore || 0) < 40 && (d.likes || 0) < 20) continue;
    items.push({
      source: "huggingface",
      id: `hf-trending:${d.id}`,
      title: d.id || "Unknown",
      description: `${entry.repoType} | trending=${d.trendingScore || 0} likes=${d.likes || 0} downloads=${d.downloads || 0}`,
      link: `https://huggingface.co/${d.id}`,
      metadata: {
        type: entry.repoType,
        trendingScore: d.trendingScore || 0,
        likes: d.likes || 0,
        tags: d.tags || [],
        pipelineTag: d.pipeline_tag,
      },
    });
  }

  // Trending models (may overlap — dedup later)
  for (const m of trendingModels) {
    if ((m.trendingScore || 0) < 40 && (m.likes || 0) < 20) continue;
    const id = `hf-model:${m.id || m.modelId}`;
    if (items.some((i) => i.id === id)) continue;
    items.push({
      source: "huggingface",
      id,
      title: m.id || m.modelId,
      description: `model | trending=${m.trendingScore || 0} likes=${m.likes || 0} downloads=${m.downloads || 0} pipeline=${m.pipeline_tag || "?"}`,
      link: `https://huggingface.co/${m.id || m.modelId}`,
      metadata: {
        type: "model",
        trendingScore: m.trendingScore || 0,
        likes: m.likes || 0,
        tags: m.tags || [],
        pipelineTag: m.pipeline_tag,
      },
    });
  }

  // Daily papers
  for (const p of dailyPapers) {
    const paper = p.paper || p;
    items.push({
      source: "huggingface",
      id: `hf-paper:${paper.id || paper.title}`,
      title: paper.title || "Untitled paper",
      description: paper.summary || "",
      link: paper.id
        ? `https://huggingface.co/papers/${paper.id}`
        : paper.url || "",
      metadata: {
        type: "paper",
        upvotes: p.numUpvotes || 0,
      },
    });
  }

  return items;
}

module.exports = { fetchTrending };

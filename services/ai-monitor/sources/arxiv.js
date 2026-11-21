const { XMLParser } = require("fast-xml-parser");

const FEED_URL = "https://rss.arxiv.org/rss/cs.AI+cs.CL+cs.LG";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function extractArxivId(link) {
  const match = (link || "").match(/abs\/(.+?)(?:v\d+)?$/);
  return match ? match[1] : link;
}

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchNewPapers() {
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`ArXiv RSS ${res.status}`);
  const xml = await res.text();
  const feed = parser.parse(xml);

  const items = feed?.rss?.channel?.item;
  if (!items) return [];

  const list = Array.isArray(items) ? items : [items];

  return list
    .filter((item) => {
      const type = item["arxiv:announce_type"] || item["announce_type"];
      return type === "new";
    })
    .map((item) => {
      const link =
        typeof item.link === "string"
          ? item.link
          : item.link?.["#text"] || item.link || "";
      return {
        source: "arxiv",
        id: extractArxivId(link),
        title: (item.title || "").replace(/\s+/g, " ").trim(),
        description: stripHtml(item.description || ""),
        link: link,
        metadata: {
          authors: item["dc:creator"] || "",
          categories: Array.isArray(item.category)
            ? item.category
            : [item.category].filter(Boolean),
        },
      };
    });
}

module.exports = { fetchNewPapers };

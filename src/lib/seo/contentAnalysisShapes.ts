// What a content-analysis result looks like — no calls, no imports, safe in a browser.
//
// Split out of `contentAnalysis.ts` for the same reason `metricsPricing.ts` was split out of
// `metrics.ts`: the Citations page renders one column per emotion and so needs this list, while
// the module that fetches the citations now opens its request through the provider log and
// reaches the Prisma client. A page importing a constant must not import a database driver.

export type Polarity = "positive" | "neutral" | "negative";
export const EMOTIONS = ["anger", "happiness", "love", "sadness", "share", "fun"] as const;
export type Emotion = typeof EMOTIONS[number];

/** The minimal result shape a web search supplies. */
export interface CitationMention {
  url: string;
  title?: string;
  snippet?: string;
  domain?: string;
  score?: number;
}

/**
 * A web-search mention has no sentiment. Returning zeroed emotions would be a measured-looking
 * lie ("neutral everywhere"), so polarity is explicitly "unknown" and sentimentAvailable is false.
 */
export function citationsFromMentions(mentions: CitationMention[]): Citation[] {
  const zeroEmotions = Object.fromEntries(EMOTIONS.map((emotion) => [emotion, 0])) as Record<Emotion, number>;
  return mentions
    .filter((mention) => !!mention.url)
    .map((mention) => ({
      url: mention.url,
      domain: mention.domain || "",
      title: mention.title || mention.url,
      snippet: mention.snippet || "",
      polarity: "unknown" as const,
      emotions: { ...zeroEmotions },
      topEmotion: undefined,
      date: "",
      score: mention.score ?? 0,
      sentimentAvailable: false,
      source: "searxng" as const,
    }));
}

export interface Citation {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  /** "unknown" when the source only supplied mentions and cannot state sentiment. */
  polarity: Polarity | "unknown";
  emotions: Record<Emotion, number>;
  topEmotion?: Emotion;
  date: string;
  score: number;
  /** false when the provider cannot supply sentiment/emotion (SearXNG). */
  sentimentAvailable?: boolean;
  source?: "dataforseo" | "searxng";
}

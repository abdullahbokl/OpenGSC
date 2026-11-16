// What a content-analysis result looks like — no calls, no imports, safe in a browser.
//
// Split out of `contentAnalysis.ts` for the same reason `metricsPricing.ts` was split out of
// `metrics.ts`: the Citations page renders one column per emotion and so needs this list, while
// the module that fetches the citations now opens its request through the provider log and
// reaches the Prisma client. A page importing a constant must not import a database driver.

export type Polarity = "positive" | "neutral" | "negative";
export const EMOTIONS = ["anger", "happiness", "love", "sadness", "share", "fun"] as const;
export type Emotion = typeof EMOTIONS[number];

/**
 * Emotions the AI path scores.
 *
 * Deliberately a different list from DataForSEO's six (\`EMOTIONS\`): those are that provider's fixed
 * counter names, and inventing numbers for them would make the two paths look comparable when they
 * are not. These are the ones a review actually expresses.
 */
export const AI_EMOTIONS = [
  "trust", "satisfaction", "appreciation", "excitement",
  "anger", "frustration", "disappointment", "fear", "concern",
] as const;
export type AiEmotion = typeof AI_EMOTIONS[number];

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
  /** Strongest emotion of whichever scale produced the verdict (DataForSEO or AI). */
  topEmotion?: Emotion | AiEmotion;
  date: string;
  score: number;
  /** false when the provider cannot supply sentiment/emotion (SearXNG). */
  sentimentAvailable?: boolean;
  source?: "dataforseo" | "searxng";
  /** Model confidence 0-1 for an analysed verdict (LLM path). */
  confidence?: number;
  /** Verbatim fragment backing the verdict; "" when the model could not judge. */
  evidence?: string;
  /** Whether the page actually discusses the brand (LLM path). */
  brandMentioned?: boolean;
  /** "<provider>/<model>" that produced the verdict, for display. */
  analyzedBy?: string;
  /**
   * Emotion scores from the AI path, on its own 0-100 scale.
   *
   * Kept separate from `emotions` (DataForSEO's fixed six counters) because the two are not the
   * same measurement: merging them would make a "happiness: 0" from one provider look like a
   * finding next to a "satisfaction: 70" from the other.
   */
  aiEmotions?: Record<string, number>;
  /** One sentence, in the page's language, on why the verdict was reached. */
  explanation?: string;
  /** The text both praised and criticised the subject. */
  mixed?: boolean;
  /** How far the row got, so the UI can count pending vs unread instead of implying coverage. */
  analysisStatus?: "classified" | "unclear" | "not-analysed";
  /** Language of the evidence ("ar", "en", "ar-en", "ru", "zh"). */
  language?: string;
  /**
   * What the verdict was actually read from: the page body, the search snippet, or the title only
   * (video pages expose nothing else). A thinner basis is a real limitation, not a detail.
   */
  evidenceSource?: "page" | "snippet" | "title";
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Quote, Loader2, AlertTriangle, Search, ExternalLink } from "lucide-react";
import { useLanguage } from "@/lib/i18n/LanguageProvider";
import { getDataForSeoKey, getSeoGenCreds, getSerpCreds, aiCredsReady } from "@/lib/seo/keys";
import { useSerpReadiness } from "@/lib/seo/useSerpReadiness";
import { EMOTIONS, type Citation } from "@/lib/seo/contentAnalysisShapes";

const card = "panel";
const POL: Record<string, string> = { positive: "var(--color-accent-green)", neutral: "var(--color-accent-orange)", negative: "var(--color-accent-red)", unknown: "var(--color-text-tertiary)" };

/** What the route reports about the analysis it actually ran (absent for DataForSEO). */
interface AnalysisInfo {
  provider?: string;
  model?: string;
  analyzed?: number;
  unclear?: number;
  unanalysed?: number;
  scraped?: number;
  error?: string;
}
const EM_KEY: Record<string, string> = { anger: "seoEmAnger", happiness: "seoEmHappiness", love: "seoEmLove", sadness: "seoEmSadness", share: "seoEmShare", fun: "seoEmFun" };

export default function CitationsPage() {
  const { t } = useLanguage();
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState<{ total: number; items: Citation[]; sentimentAvailable?: boolean; source?: string; analysis?: AnalysisInfo } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dfsKey = mounted ? getDataForSeoKey() : "";
  const serpCreds = mounted ? getSerpCreds() : { provider: "", apiKey: "" };
  const serpReady = useSerpReadiness(serpCreds);
  // Sentiment without DataForSEO: SearXNG finds the mentions, the configured chat model reads them.
  const ai = mounted ? getSeoGenCreds() : { provider: "", apiKey: "", model: "", baseUrl: undefined as string | undefined };
  const aiReady = mounted && aiCredsReady(ai);
  const canSearch = !!dfsKey || serpReady;
  const willAnalyze = !dfsKey && serpReady && aiReady;

  async function run() {
    setErr(""); setData(null);
    const dfsKey = getDataForSeoKey();
    if (!dfsKey && !serpReady) { setErr(t("seoCitNeedProvider")); return; }
    if (!keyword.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/seo/content-analysis", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword,
          dfsKey,
          provider: dfsKey ? "dataforseo" : "searxng",
          aiProvider: ai.provider,
          aiApiKey: ai.apiKey,
          // Only a model the user actually chose is forwarded. `getSeoGenCreds()` also returns the
          // provider default, and on this deployment that default is a reasoning model that spends
          // a short classification's whole budget thinking — the route picks a task model instead.
          aiModel: (typeof window !== "undefined" ? localStorage.getItem("seoModel") : "") || undefined,
          aiBaseUrl: ai.baseUrl || undefined,
          hl: typeof navigator !== "undefined" ? navigator.language.split("-")[0] : undefined,
          limit: 200,
          maxItems: 24,
        }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.error || "error"); setLoading(false); return; }
      setData({
        total: d.total ?? (d.items?.length || 0),
        items: d.items || [],
        sentimentAvailable: d.sentimentAvailable !== false,
        source: d.source,
        analysis: d.analysis,
      });
    } catch (e) { setErr(String((e as Error)?.message ?? e)); }
    setLoading(false);
  }

  const agg = useMemo(() => {
    const items = data?.items || [];
    const pol = { positive: 0, neutral: 0, negative: 0 } as Record<string, number>;
    const emo: Record<string, number> = Object.fromEntries(EMOTIONS.map(e => [e, 0]));
    const domains: Record<string, number> = {};
    const byDate: Record<string, number> = {};
    items.forEach(c => {
      pol[c.polarity] = (pol[c.polarity] || 0) + 1;
      EMOTIONS.forEach(e => { emo[e] += Number(c.emotions?.[e] || 0); });
      if (c.domain) domains[c.domain] = (domains[c.domain] || 0) + 1;
      if (c.date) { const m = c.date.slice(0, 7); byDate[m] = (byDate[m] || 0) + 1; }
    });
    const topDomains = Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const trend = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
    const emoMax = Math.max(1, ...Object.values(emo));
    const trendMax = Math.max(1, ...trend.map(([, n]) => n));
    return { pol, emo, emoMax, topDomains, trend, trendMax, n: items.length };
  }, [data]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <h2 style={{ fontSize: "20px", fontWeight: 700, color: "var(--color-text-primary)", margin: "0 0 4px", display: "flex", alignItems: "center", gap: "9px" }}><Quote size={20} color="var(--color-accent-purple)" /> {t("seoCitTitle")}</h2>
        <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", margin: 0 }}>{t("seoCitSub")}</p>
      </div>

      {mounted && !dfsKey && (
        <div className={card} style={{
          borderColor: !canSearch ? "rgba(255,159,10,0.35)" : willAnalyze ? "rgba(41,151,255,0.35)" : "rgba(255,159,10,0.35)",
          background: !canSearch ? "rgba(255,159,10,0.06)" : willAnalyze ? "rgba(41,151,255,0.06)" : "rgba(255,159,10,0.06)",
          display: "flex", gap: "10px", alignItems: "center", fontSize: "13px", color: "var(--color-text-secondary)",
        }}>
          <AlertTriangle size={18} color={!canSearch || !willAnalyze ? "var(--color-accent-orange)" : "var(--color-accent-blue)"} />
          {!canSearch ? t("seoCitNeedProvider") : willAnalyze ? t("seoCitAiBanner") : t("seoCitSerpOnlyAi")}
          <Link href={willAnalyze ? "/settings?tab=serp" : "/settings?tab=ai"} style={{ color: "var(--color-accent-blue)" }}>{t("seoSettingsShort")}</Link>
        </div>
      )}

      <div className={card}>
        <div style={{ display: "flex", gap: "10px" }}>
          <input className="tool-input" style={{ flex: 1 }} value={keyword} onChange={e => setKeyword(e.target.value)} placeholder={t("seoCitInputPh")} onKeyDown={e => e.key === "Enter" && run()} />
          <button onClick={run} disabled={loading || !keyword.trim()} style={{ display: "flex", alignItems: "center", gap: "7px", padding: "9px 18px", borderRadius: "8px", border: "none", background: "var(--color-accent-purple)", color: "#fff", fontSize: "13px", fontWeight: 600, cursor: keyword.trim() ? "pointer" : "not-allowed", opacity: keyword.trim() ? 1 : 0.5 }}>
            {loading ? <Loader2 size={15} className="spin" /> : <Search size={15} />} {t("seoCitRun")}
          </button>
        </div>
      </div>

      {err && <div className={card} style={{ borderColor: "rgba(255,69,58,0.35)", background: "rgba(255,69,58,0.06)", color: "var(--color-accent-red)", fontSize: "13px", display: "flex", gap: "8px", alignItems: "center" }}><AlertTriangle size={16} /> {err}</div>}

      {data && (data.items.length === 0 ? (
        <div className={card} style={{ textAlign: "center", color: "var(--color-text-secondary)", fontSize: "13px" }}>{t("seoCitEmpty")}</div>
      ) : (
        <>
          {/* summary cards — sentiment only when the provider can actually supply it */}
          {data.sentimentAvailable === false ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: "12px" }}>
                <Stat big label={t("seoCitTotal")} value={(data.total || agg.n).toLocaleString()} sub={`${agg.n} ${t("seoCitShown")}`} color="var(--color-text-primary)" />
                <Stat label={t("seoCitTopDomains")} value={String(agg.topDomains.length)} color="var(--color-accent-purple)" />
              </div>
              <div className={card} style={{ borderColor: "rgba(255,159,10,0.35)", background: "rgba(255,159,10,0.06)", fontSize: "13px", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: "8px" }}>
                <AlertTriangle size={16} color="var(--color-accent-orange)" /> {t("seoCitSentimentUnavailable")}
              </div>
            </>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: "12px" }}>
              <Stat big label={t("seoCitTotal")} value={(data.total || agg.n).toLocaleString()} sub={`${agg.n} ${t("seoCitShown")}`} color="var(--color-text-primary)" />
              <Stat label={t("seoCitPositive")} value={String(agg.pol.positive)} color={POL.positive} />
              <Stat label={t("seoCitNeutral")} value={String(agg.pol.neutral)} color={POL.neutral} />
              <Stat label={t("seoCitNegative")} value={String(agg.pol.negative)} color={POL.negative} />
            </div>
          )}

          {data.analysis && (
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
              {t("seoCitAiSummary")
                .replace("{analyzed}", String(data.analysis.analyzed ?? 0))
                .replace("{total}", String(data.items.length))
                .replace("{model}", data.analysis.model || data.analysis.provider || "AI")
                .replace("{scraped}", String(data.analysis.scraped ?? 0))}
              {data.analysis.unclear ? ` · ${t("seoCitAiUnclear").replace("{n}", String(data.analysis.unclear))}` : ""}
              {data.analysis.unanalysed ? ` · ${t("seoCitAiSkipped").replace("{n}", String(data.analysis.unanalysed))}` : ""}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", alignItems: "start" }}>
            {/* emotions — DataForSEO counters or AI scores, whichever ran */}
            {data.sentimentAvailable !== false && (
              <div className={card}>
                <div className="tool-section-label" style={{ marginBottom: "12px" }}>{t("seoCitEmotions")}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {EMOTIONS.map(e => (
                    <div key={e} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "12px", color: "var(--color-text-secondary)", width: "80px", flexShrink: 0 }}>{t(EM_KEY[e] as Parameters<typeof t>[0])}</span>
                      <div style={{ flex: 1, height: "8px", borderRadius: "4px", background: "var(--color-bg)", overflow: "hidden" }}>
                        <div style={{ width: `${(agg.emo[e] / agg.emoMax) * 100}%`, height: "100%", background: "var(--color-accent-purple)" }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* trend */}
            <div className={card}>
              <div className="tool-section-label" style={{ marginBottom: "12px" }}>{t("seoCitTrend")}</div>
              {agg.trend.length === 0 ? <div style={{ fontSize: "12px", color: "var(--color-text-tertiary)" }}>—</div> : (
                <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "120px" }}>
                  {agg.trend.map(([m, n]) => (
                    <div key={m} title={`${m}: ${n}`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", justifyContent: "flex-end" }}>
                      <div style={{ width: "100%", maxWidth: "26px", height: `${(n / agg.trendMax) * 96}px`, background: "var(--color-accent-blue)", borderRadius: "3px 3px 0 0" }} />
                      <span style={{ fontSize: "9px", color: "var(--color-text-tertiary)", transform: "rotate(-45deg)", whiteSpace: "nowrap" }}>{m.slice(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* top domains */}
          {agg.topDomains.length > 0 && (
            <div className={card}>
              <div className="tool-section-label" style={{ marginBottom: "12px" }}>{t("seoCitTopDomains")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {agg.topDomains.map(([d, n]) => <span key={d} className="pill">{d} · {n}</span>)}
              </div>
            </div>
          )}

          {/* citations list */}
          <div className={card}>
            <div className="tool-section-label" style={{ marginBottom: "12px" }}>{t("seoCitList")} ({agg.n})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {data.items.map((c, i: number) => (
                <div key={i} style={{ padding: "11px 13px", border: "1px solid var(--color-border)", borderRadius: "9px", fontSize: "13px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "4px", flexWrap: "wrap" }}>
                    <span style={{ width: 9, height: 9, borderRadius: "50%", background: POL[c.polarity] || "#888", flexShrink: 0 }} />
                    <a href={c.url} target="_blank" rel="noreferrer" style={{ flex: 1, minWidth: "200px", color: "var(--color-text-primary)", fontWeight: 600, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title} <ExternalLink size={11} style={{ display: "inline", verticalAlign: "middle", color: "var(--color-text-tertiary)" }} /></a>
                    {c.topEmotion && <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "20px", color: "var(--color-accent-purple)", background: "rgba(191,90,242,0.12)" }}>{t(EM_KEY[c.topEmotion] as Parameters<typeof t>[0])}</span>}
                    {typeof c.confidence === "number" && c.polarity !== "unknown" && (
                      <span style={{ fontSize: "10px", fontWeight: 600, padding: "2px 8px", borderRadius: "20px", color: "var(--color-text-secondary)", background: "var(--color-bg)" }}>
                        {t("seoCitConfidence").replace("{n}", String(Math.round(c.confidence * 100)))}
                      </span>
                    )}
                    <span style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{c.domain}{c.date ? ` · ${c.date}` : ""}</span>
                  </div>
                  {c.snippet && <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{c.snippet}</div>}
                  {c.evidence && <div style={{ marginTop: "5px", fontSize: "11px", color: "var(--color-text-tertiary)", fontStyle: "italic" }}>“{c.evidence}”</div>}
                  {c.polarity === "unknown" && c.sentimentAvailable && <div style={{ marginTop: "5px", fontSize: "11px", color: "var(--color-text-tertiary)" }}>{t("seoCitNoEvidence")}</div>}
                </div>
              ))}
            </div>
          </div>
        </>
      ))}
    </div>
  );
}

function Stat({ label, value, sub, color, big }: { label: string; value: string; sub?: string; color: string; big?: boolean }) {
  return (
    <div className="panel" style={{ padding: "16px" }}>
      <div style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{label}</div>
      <div style={{ fontSize: big ? "28px" : "24px", fontWeight: 700, color, marginTop: "2px" }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: "var(--color-text-tertiary)" }}>{sub}</div>}
    </div>
  );
}

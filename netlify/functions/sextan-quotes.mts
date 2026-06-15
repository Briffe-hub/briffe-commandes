/**
 * Netlify Function : sextan-quotes
 * Proxy vers l'API Sextan via cookie de session SEXTAN_SID
 */
import type { Config } from "@netlify/functions";

const BASE = Netlify.env.get("SEXTAN_BASE") ?? "https://briffe.sextan.catering";
const SID  = Netlify.env.get("SEXTAN_SID")  ?? "";

async function fetchQuotes(from: string, to: string, offset = 0, limit = 100) {
  const resp = await fetch(`${BASE}/api/quotes/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `SEXTAN_SID=${SID}`,
    },
    body: JSON.stringify({ from, to, limit, offset }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<Record<string, unknown>>;
}

interface ProjetRow { nom: string; client: string; mois: string; ht: number; date: string }

const MOIS_FR: Record<string, number> = {
  janvier:1,fevrier:2,février:2,mars:3,avril:4,mai:5,juin:6,
  juillet:7,aout:8,août:8,septembre:9,octobre:10,novembre:11,
  decembre:12,décembre:12,
};
const MOIS_MAP: Record<string, string> = {
  "2026-4":"Avril 2026","2026-5":"Mai 2026","2026-6":"Juin 2026",
  "2026-7":"Juillet 2026","2026-8":"Août 2026","2026-9":"Septembre 2026",
  "2026-10":"Octobre 2026","2026-11":"Novembre 2026","2026-12":"Décembre 2026",
  "2027-1":"Janvier 2027","2027-2":"Février 2027","2027-3":"Mars 2027",
  "2027-4":"Avril 2027","2027-5":"Mai 2027","2027-6":"Juin 2027",
  "2027-7":"Juillet 2027","2027-8":"Août 2027","2027-9":"Septembre 2027",
  "2027-10":"Octobre 2027","2027-11":"Novembre 2027","2027-12":"Décembre 2027",
};

function norm(s: string) { return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

function devinerMois(nom: string, fallback: string): string | null {
  const m1 = nom.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m1) return MOIS_MAP[`${m1[3]}-${parseInt(m1[2])}`] ?? null;
  const lower = norm(nom);
  for (const [mot, num] of Object.entries(MOIS_FR)) {
    const match = lower.match(new RegExp(norm(mot) + "[^\\d]*(\\d{4})"));
    if (match) return MOIS_MAP[`${match[1]}-${num}`] ?? null;
  }
  if (fallback?.length >= 7)
    return MOIS_MAP[`${parseInt(fallback.slice(0,4))}-${parseInt(fallback.slice(5,7))}`] ?? null;
  return null;
}

function traiterDevis(quotes: Record<string, unknown>[]): ProjetRow[] {
  const map = new Map<number, { nom: string; client: string; ht: number; date: string }>();
  for (const q of quotes) {
    const project = q.project as { id: number; name: string };
    const client  = q.client  as { name: string };
    const total   = q.total   as { ht: number };
    const pid = project.id, date = q.date as string;
    const ht = parseFloat(String(total.ht)) || 0;
    const ex = map.get(pid);
    if (!ex || date >= ex.date) map.set(pid, { nom: project.name.trim(), client: client.name.trim(), ht, date });
  }
  const rows: ProjetRow[] = [];
  for (const p of map.values()) {
    if (p.ht <= 0) continue;
    const mois = devinerMois(p.nom, p.date);
    if (mois) rows.push({ nom: p.nom, client: p.client, mois, ht: p.ht, date: p.date });
  }
  const order = Object.values(MOIS_MAP);
  rows.sort((a, b) => (order.indexOf(a.mois) - order.indexOf(b.mois)) || (b.ht - a.ht));
  return rows;
}

export default async (req: Request): Promise<Response> => {
  if (!SID)
    return Response.json({ success: false, error: "Variable SEXTAN_SID manquante" }, { status: 500 });

  const url  = new URL(req.url);
  const from = url.searchParams.get("from") ?? "2026-04-01";
  const to   = url.searchParams.get("to")   ?? "2026-12-31";

  try {
    let allQuotes: Record<string, unknown>[] = [];
    let offset = 0;
    while (true) {
      const page  = await fetchQuotes(from, to, offset, 100);
      const data  = (page.data ?? []) as Record<string, unknown>[];
      const count = (page.count ?? 0) as number;
      allQuotes = allQuotes.concat(data);
      if (allQuotes.length >= count || data.length === 0) break;
      offset += 100;
    }
    return Response.json({ success: true, count: allQuotes.length, from, to, data: traiterDevis(allQuotes) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ success: false, error: msg }, { status: 500 });
  }
};

export const config: Config = { path: "/api/sextan-quotes" };

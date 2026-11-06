// Sincronizzazione automatica: agenda di ClasseViva -> Diario di Classe (Supabase).
// Gira da solo su GitHub Actions (vedi .github/workflows/registro.yml).
// Importa solo verifiche e interrogazioni; non tocca mai ciò che la classe ha inserito a mano.

import { readFileSync } from "node:fs";

const CVV_USER = process.env.CVV_USER;
const CVV_PASS = process.env.CVV_PASS;
const SB_URL = process.env.SUPABASE_URL || "https://rfphgyphgxtmdzahzqtu.supabase.co";
const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_Ibw7Jmbyu2eD3RNRhLxsEQ_Wu4bjXTq";
const PROVA = process.argv.includes("--prova"); // mostra cosa farebbe, senza scrivere

const CVV = "https://web.spaggiari.eu/rest/v1";
const CVV_HEADERS = {
  "User-Agent": "CVVS/std/4.2.3 Android/12",
  "Z-Dev-Apikey": "Tg1NWEwNGIgIC0K",
  "Content-Type": "application/json"
};

// Docenti -> materia (compilalo in sync/docenti.json, es. {"ROSSI MARIO": "Arte"})
let DOCENTI = {};
try { DOCENTI = JSON.parse(readFileSync(new URL("./docenti.json", import.meta.url), "utf8")); } catch {}

const RE_INTERR = /\binterroga(zion[ei]|t[oi])?\b|\binterr\.\s/i;
const RE_VERIF = /\bverific[ah]e?\b|\bcompit[oi] in classe\b|\btest\b|\bprova (scritta|comune|pratica|orale|di)\b|\bsimulazione\b|\bquestionario\b|\bcompito (scritto|di)\b/i;

const iso = d => d.toISOString().slice(0, 10);
const ymd = d => iso(d).replace(/-/g, "");
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const capit = s => String(s || "").toLowerCase().replace(/(^|[\s'’-])\p{L}/gu, m => m.toUpperCase());

function materiaDi(ev) {
  if (ev.subjectDesc) return capit(ev.subjectDesc);
  const autore = norm(ev.authorName);
  for (const [nome, mat] of Object.entries(DOCENTI)) if (norm(nome) === autore) return mat;
  return "Prof. " + capit(ev.authorName || "?"); // da sistemare in docenti.json
}

function tipoDi(ev) {
  const t = `${ev.notes || ""}`;
  if (ev.evtCode === "AGHW") return null;            // compiti per casa: esclusi
  if (RE_INTERR.test(t)) return "interrogazione";
  if (RE_VERIF.test(t)) return "verifica";
  return null;                                        // avvisi, uscite, ecc.: esclusi
}

async function cvv() {
  const r = await fetch(CVV + "/auth/login", {
    method: "POST", headers: CVV_HEADERS,
    body: JSON.stringify({ ident: null, pass: CVV_PASS, uid: CVV_USER })
  });
  const testo = await r.text();
  let j = {}; try { j = JSON.parse(testo); } catch {}
  if (!r.ok || !j.token) {
    const dettaglio = j.error || j.message || j.info || testo.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error("Accesso a ClasseViva non riuscito (" + r.status + "). Risposta di Spaggiari: " + (dettaglio || "(vuota)"));
  }
  const id = String(j.ident).replace(/\D/g, "");
  const oggi = new Date(); oggi.setUTCHours(0, 0, 0, 0);
  const fine = new Date(oggi); fine.setUTCDate(fine.getUTCDate() + 120);
  const a = await fetch(`${CVV}/students/${id}/agenda/all/${ymd(oggi)}/${ymd(fine)}`, {
    headers: { ...CVV_HEADERS, "Z-Auth-Token": j.token }
  });
  if (!a.ok) throw new Error("Lettura agenda non riuscita (" + a.status + ")");
  return { eventi: (await a.json()).agenda || [], da: iso(oggi), a: iso(fine) };
}

const SB_H = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
async function sb(path, opt = {}) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, { ...opt, headers: { ...SB_H, ...(opt.headers || {}) } });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + (await r.text()));
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function main() {
  if (!CVV_USER || !CVV_PASS) throw new Error("Mancano CVV_USER e CVV_PASS (vanno nei Secrets del repository).");
  const { eventi, da, a } = await cvv();

  const righe = await sb("docs?collection=eq.eventi&select=id,data");
  const esistenti = righe.map(r => ({ id: r.id, ...r.data }));
  const dalRegistro = new Map(esistenti.filter(e => e.fonte === "registro").map(e => [e.cvvId, e]));
  const aMano = esistenti.filter(e => e.fonte !== "registro");

  const visti = new Set();
  const nuovi = [], aggiornati = [], rimossi = [];

  for (const ev of eventi) {
    const tipo = tipoDi(ev);
    if (!tipo) continue;
    const cvvId = String(ev.evtId);
    visti.add(cvvId);
    const data = String(ev.evtDatetimeBegin || "").slice(0, 10);
    const materia = materiaDi(ev);
    const nota = String(ev.notes || "").trim();

    const gia = dalRegistro.get(cvvId);
    if (gia) {
      // il prof ha spostato la data o cambiato il testo: aggiorno solo quei campi
      const patch = {};
      if (gia.data !== data) patch.data = data;
      if ((gia.notaRegistro || "") !== nota) { patch.notaRegistro = nota; if (!gia.modificato && !gia.turnoId) patch.argomenti = nota; }
      if (Object.keys(patch).length) aggiornati.push({ id: gia.id, patch, descr: `${materia} ${data}` });
      continue;
    }
    // già segnata a mano dalla classe? (stesso giorno, stesso tipo, stessa materia)
    const doppione = aMano.find(e => e.data === data && e.tipo === tipo && norm(e.materia).slice(0, 4) === norm(materia).slice(0, 4));
    if (doppione) continue;

    nuovi.push({
      id: "cvv" + cvvId,
      data: { tipo, materia, data, argomenti: nota, studenti: [], turnoId: "", fonte: "registro",
              cvvId, notaRegistro: nota, docente: capit(ev.authorName || ""), creato: Date.now(), creatoDa: "Registro" }
    });
  }

  // eventi futuri cancellati dal prof: li tolgo solo se nessuno li ha toccati
  for (const [cvvId, e] of dalRegistro) {
    if (visti.has(cvvId) || e.data < da || e.data > a) continue;
    if (e.modificato || e.turnoId || (e.studenti || []).length) continue;
    rimossi.push(e);
  }

  console.log(`Agenda letta: ${eventi.length} voci dal ${da} al ${a}.`);
  console.log(`Nuove: ${nuovi.length} · Aggiornate: ${aggiornati.length} · Tolte: ${rimossi.length}`);
  nuovi.forEach(n => console.log("  + " + n.data.tipo + " " + n.data.materia + " " + n.data.data + " — " + n.data.argomenti.slice(0, 70)));
  aggiornati.forEach(u => console.log("  ~ " + u.descr + " " + JSON.stringify(u.patch).slice(0, 90)));
  rimossi.forEach(e => console.log("  - " + e.materia + " " + e.data));
  if (PROVA) { console.log("(prova: nessuna modifica scritta)"); return; }

  const ora = new Date().toISOString();
  if (nuovi.length) await sb("docs", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify(nuovi.map(n => ({ collection: "eventi", id: n.id, data: n.data, updated_at: ora })))
  });
  for (const u of aggiornati) await sb("rpc/merge_doc", {
    method: "POST", body: JSON.stringify({ p_collection: "eventi", p_id: u.id, p_patch: u.patch })
  });
  for (const e of rimossi) await sb(`docs?collection=eq.eventi&id=eq.${encodeURIComponent(e.id)}`, { method: "DELETE" });

  await sb("docs", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ collection: "sistema", id: "registro", data: { ultimoAggiornamento: ora, nuovi: nuovi.length }, updated_at: ora }])
  });
}

main().catch(e => { console.error("ERRORE: " + e.message); process.exit(1); });

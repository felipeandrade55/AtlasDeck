/**
 * Extrai um nome de cidade curto a partir de uma resposta do Nominatim.
 * Prefere campos estruturados (city/town/village/...). Estado opcional como sufixo curto.
 */
export interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  hamlet?: string;
  suburb?: string;
  city_district?: string;
  state?: string;
  state_district?: string;
  country?: string;
  country_code?: string;
}

const BR_STATE_ABBR: Record<string, string> = {
  "acre": "AC", "alagoas": "AL", "amapá": "AP", "amapa": "AP",
  "amazonas": "AM", "bahia": "BA", "ceará": "CE", "ceara": "CE",
  "distrito federal": "DF", "espírito santo": "ES", "espirito santo": "ES",
  "goiás": "GO", "goias": "GO", "maranhão": "MA", "maranhao": "MA",
  "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG",
  "pará": "PA", "para": "PA", "paraíba": "PB", "paraiba": "PB",
  "paraná": "PR", "parana": "PR", "pernambuco": "PE",
  "piauí": "PI", "piaui": "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS",
  "rondônia": "RO", "rondonia": "RO", "roraima": "RR",
  "santa catarina": "SC", "são paulo": "SP", "sao paulo": "SP",
  "sergipe": "SE", "tocantins": "TO",
};

function stateAbbr(state?: string): string | null {
  if (!state) return null;
  const k = state.trim().toLowerCase();
  return BR_STATE_ABBR[k] ?? null;
}

function titleCaseIfAllCaps(s: string): string {
  if (!s) return s;
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
    // Conectores comuns em minúsculas
    .replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
}

/**
 * A partir de um objeto `address` do Nominatim (addressdetails=1),
 * retorna "Cidade" ou "Cidade, UF" quando estado for BR conhecido.
 */
export function cityFromAddress(addr: NominatimAddress | undefined | null): string | null {
  if (!addr) return null;
  const city =
    addr.city ||
    addr.town ||
    addr.village ||
    addr.municipality ||
    addr.hamlet ||
    addr.suburb ||
    addr.city_district ||
    addr.county ||
    null;
  if (!city) return null;
  const clean = titleCaseIfAllCaps(city);
  const uf = stateAbbr(addr.state);
  return uf ? `${clean}, ${uf}` : clean;
}

/**
 * Heurística para encurtar um `display_name` antigo (sem dados estruturados)
 * salvo no banco. Pula ruas, CEPs, regiões geográficas e países, pega o
 * primeiro segmento "real" — tipicamente a cidade.
 */
export function shortCityName(label: string | null | undefined): string {
  if (!label) return "";
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return titleCaseIfAllCaps(label.trim());

  const isStreet = (p: string) =>
    /^(av\.?|avenida|rua|r\.|alameda|al\.|travessa|tv\.?|rod\.?|rodovia|estrada|est\.?|praça|praca|largo|via|beco|servidão|servidao|caminho)\b/i.test(
      p,
    );
  const isPostal = (p: string) => /^\d{5}-?\d{3}$/.test(p) || /^\d{4,8}$/.test(p);
  const isRegion = (p: string) => /^regi[aã]o\b/i.test(p);
  const isCountry = (p: string) =>
    /^(brasil|brazil|portugal|argentina|chile|paraguai|paraguay|uruguai|uruguay|bol[íi]via|bolivia|estados unidos|united states|espanha|spain)$/i.test(
      p,
    );
  const isStateName = (p: string) => stateAbbr(p) !== null;

  let chosen: string | null = null;
  let chosenIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (isStreet(p) || isPostal(p) || isRegion(p) || isCountry(p) || isStateName(p)) continue;
    chosen = p;
    chosenIdx = i;
    break;
  }
  if (!chosen) chosen = parts[0];

  // Tenta achar um estado BR após a cidade escolhida para sufixar como UF
  let uf: string | null = null;
  for (let i = chosenIdx + 1; i < parts.length; i++) {
    const candidate = stateAbbr(parts[i]);
    if (candidate) {
      uf = candidate;
      break;
    }
  }

  const city = titleCaseIfAllCaps(chosen);
  return uf ? `${city}, ${uf}` : city;
}

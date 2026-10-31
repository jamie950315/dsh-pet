/**
 * 檢索用的輕量向量：無外部依賴的雜湊字元 bigram 向量 + 餘弦相似度。
 *
 * 為什麼不用 embedding API：桌寵要能在任何服務商下離線檢索，且不額外花錢；
 * 中文以字元 bigram + 拉丁詞做詞彙級相似度，足以支撐「同義／近義改寫」的召回。
 * @module dsh-pet/src/host/memory/vector
 */

/** 向量維度：256 在桌寵規模下足夠分散，且 JSON 體積可控。 */
export const VECTOR_DIM = 256;

/** 取詞：CJK 字元 bigram + 拉丁／數字詞（長度 ≥ 2）。 */
export function tokens(text: string): string[] {
  const normalized = text.toLowerCase();
  const chars = Array.from(normalized);
  const out: string[] = [];
  if (chars.length > 1) {
    for (let i = 0; i < chars.length - 1; i += 1) {
      const pair = chars[i] + chars[i + 1];
      if (/\S\S/.test(pair)) out.push(pair);
    }
  }
  for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length > 1) out.push(word);
  }
  return out;
}

/** FNV-1a 32 位元雜湊（穩定、無依賴）。 */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 把文字轉成 L2 正規化後的 256 維向量。 */
export function vector(text: string): number[] {
  const out = new Array<number>(VECTOR_DIM).fill(0);
  const list = tokens(text);
  if (list.length === 0) return out;
  for (const token of list) {
    const h = hash(token);
    const index = h % VECTOR_DIM;
    const sign = (h & 0x10000) === 0 ? 1 : -1;
    out[index] += sign;
  }
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < out.length; i += 1) out[i] /= norm;
  }
  return out;
}

/** 餘弦相似度；維度不符或空向量回 0。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 詞彙重疊分數：查詢詞與記憶正文／關鍵詞的 bigram 召回率與精確率加權。 */
export function lexicalScore(query: string, content: string, keywords: readonly string[]): number {
  const queryTokens = new Set(tokens(query));
  if (queryTokens.size === 0) return 0;
  const memoryTokens = new Set(tokens(content + ' ' + keywords.join(' ')));
  if (memoryTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (memoryTokens.has(token)) overlap += 1;
  const recall = overlap / queryTokens.size;
  const precision = overlap / memoryTokens.size;
  return Math.min(1, 0.7 * recall + 0.3 * precision);
}

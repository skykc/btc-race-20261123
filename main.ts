// Stabilised dip-buy cbBTC bot — patient entries, profit-target exits.
//
// Pola juara 1 edisi lalu (@strescco, final +24,2 USDC, 4 trade, win 100%):
// sedikit trade, sabar menunggu dip, hold berjam-jam menahan drawdown intraday,
// jual hanya setelah harga menguat berjam-jam. Bukan kode juara (tidak pernah
// dipublikasikan) — hanya polanya, ditulis fresh dari RULES + studi kekalahan.
//
// Yang TIDAK diulangi dari bot kami yang kalah (final -13,95 USDC, win 0%):
// trailing stop 150 bps dan exit RSI>65 yang memotong posisi di kaki rally dan
// di dasar dip. Di sini TIDAK ADA stop-loss yang merealisasikan rugi: exit
// hanya (A) target profit, (B) panen posisi basi yang sudah untung, (C) trailing
// 300 bps yang hanya mengunci profit, (D) akhir window bila sudah untung,
// (E) kelelahan: RSI>70 + close turun di bawah EMA(10) setelah di atas.
// Satu posisi, all-in, long only, 1.000 USDC, deterministik penuh (tanpa jam,
// tanpa acak — semua murni fungsi dari aliran bar).
//
// Kalibrasi dev window ini (1.440 bar, range close 5,09%, stdev 1 menit 8,13 bps,
// buy-and-hold +34,82 USDC sebelum impact): dip yang berarti adalah puluhan bps,
// biaya round trip penuh ~26 bps, jadi target profit harus jauh di atas itu.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL_FALLBACK = 'CBBTC';

// --- Parameter (semua bernama, semua dengan alasan) ---------------------------------
// Jendela 24 jam = 1.440 bar 1 menit (RULES: dev dan race sama-sama 1.440 bar).
const TOTAL_BARS = 1440;
// Sejarah minimum sebelum entry pertama: RSI(14) + EMA(10) + high 120 bar butuh data.
const HISTORY_MIN_BARS = 60;
// Puncak acuan dip: harga tertinggi 120 bar terakhir (2 jam).
const LOOKBACK_HIGH_BARS = 120;
// Dip minimum dari puncak 2 jam: 35 bps (~4,3x stdev 1 menit 8,13 bps — masih
// jauh di atas noise, tapi cukup longgar untuk menangkap dip yang lebih dangkal
// di tren naik; iterasi 2: diturunkan dari 50 bps karena di window dev dip
// >=50 bps hampir tidak pernah terbentuk saat harga mencetak high baru terus).
const DIP_BPS = 35;
// RSI(14) Wilder; entry hanya saat RSI <= 50 DAN RSI sedang naik (stabilisasi:
// pantulan sudah mulai, bukan pisau jatuh). Iterasi 2: batas dilonggarkan dari
// 45 ke 50 — syarat RSI naik + close > EMA(10) sudah menyaring pisau jatuh,
// dan di pasar tren naik RSI jarang turun sampai <= 45.
const RSI_PERIOD = 14;
const RSI_ENTRY_MAX = 50;
// (E) Kelelahan (exhaustion): RSI(14) > 70 DAN close turun di bawah EMA(10)
// setelah sebelumnya di atas — pembalikan TERKONFIRMASI dua syarat, bukan
// RSI sendirian (exit RSI>65 sendirian membunuh bot lama di kaki rally).
// Hanya bila posisi sudah untung; tidak pernah merealisasikan rugi.
const RSI_EXHAUST = 70;
// Stabilisasi kedua: close harus sudah kembali di atas EMA(10).
const EMA_SHORT = 10;
// (A) Target profit: untung kotor 250 bps vs biaya masuk (fee sudah di cost);
// bersih ~+224 bps setelah fee+slippage+impact keluar (~26 bps round trip).
// Naik dari 150 bps: di window dev yang trending, target 150 menjual tepat di
// tengah rally; 250 bps membiarkan posisi menunggangi rally lebih lama,
// seperti hold 3 jam 47 mnt / 6 jam juara 1 edisi lalu.
const TARGET_BPS = 250;
// (B) Panen posisi basi: hold >= 6 jam dan untung >= 40 bps -> jual (ala hold 6 jam juara).
const STALE_BARS = 360;
const STALE_MIN_BPS = 40;
// (C) Trailing dari puncak sejak entry: 300 bps (batas bawah yang diizinkan G-BTC3)
// dan HANYA bila masih untung >= 50 bps — tidak pernah merealisasikan rugi.
const TRAIL_BPS = 300;
const TRAIL_MIN_BPS = 50;
// Jeda 15 bar setelah exit sebelum entry baru. Turun dari 60: syarat dip
// >= 50 bps dari puncak 120 bar SUDAH mencegah beli-ulang di high yang sama;
// cooldown 60 bar hanya membuat bot ketinggalan pantulan berikutnya.
const COOLDOWN_BARS = 15;
// Jeda 10 bar setelah order beli ditolak (mis. max_slippage) sebelum mencoba lagi.
const RETRY_BARS = 10;
// Jangan ambil trade baru di 2 jam terakhir window (G-BTC5: tanpa waktu pulih).
const NO_ENTRY_LAST_BARS = 120;
// Di 60 bar terakhir, jual bila sudah untung >= 30 bps (kunci profit kecil);
// bila rugi, tahan sampai flatten akhir (sama saja, hindari jual di dasar).
const END_SELL_LAST_BARS = 60;
const END_SELL_MIN_BPS = 30;
// Maks 6 round trip per window (G-BTC5: target ~4, >8 = overtrading).
const MAX_ROUND_TRIPS = 6;
// Slippage maksimum dari close terakhir: 150 bps (pilihan juara 1) — cukup longgar
// untuk fill normal (slippage model 2 bps + impact ~7 bps), cukup ketat untuk
// menolak beli di gap-up yang curam.
const MAX_SLIPPAGE_BPS = 150;

// --- Indikator (murni fungsi dari array closes; deterministik) ------------------------

/** Wilder RSI(period) atas closes (Number). Butuh period+1 closes; bila kurang, 50. */
function rsi(closes: readonly number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  // Wilder smoothing atas sisa delta (seed = rata-rata `period` delta pertama).
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** EMA(period) atas closes; seed = close pertama. */
function ema(closes: readonly number[], period: number): number {
  const k = 2 / (period + 1);
  let e = closes[0]!;
  for (let i = 1; i < closes.length; i++) e = closes[i]! * k + e * (1 - k);
  return e;
}

/** Harga tertinggi dari `n` closes terakhir. */
function recentHigh(closes: readonly number[], n: number): number {
  let h = -Infinity;
  const from = Math.max(0, closes.length - n);
  for (let i = from; i < closes.length; i++) if (closes[i]! > h) h = closes[i]!;
  return h;
}

/** Selisih (a - b) / a dalam bps, a > 0. */
function bpsDown(a: number, b: number): number {
  return ((a - b) / a) * 10_000;
}

// --- State mesin strategi -----------------------------------------------------------

type Mode = 'flat' | 'pendingBuy' | 'pendingSell';

interface BotState {
  symbol: string;
  closes: number[];
  opens: number[];
  mode: Mode;
  /** Harga fill beli (integer, skala harga), dari batch.fills. */
  entryPrice: bigint | null;
  /** Seq batch saat beli terisi. */
  entrySeq: number;
  /** Close tertinggi sejak entry (Number), untuk trailing 300 bps. */
  peakClose: number;
  roundTrips: number;
  /** Seq paling awal entry baru diizinkan (cooldown setelah exit). */
  cooldownUntilSeq: number;
  /** Seq paling awal percobaan beli ulang setelah order ditolak. */
  retryUntilSeq: number;
  /** Apakah close bar sebelumnya di atas EMA(10) — lengan cek kelelahan (E). */
  aboveEmaPrev: boolean;
}

const bot: BotState = {
  symbol: SYMBOL_FALLBACK,
  closes: [],
  opens: [],
  mode: 'flat',
  entryPrice: null,
  entrySeq: -1,
  peakClose: 0,
  roundTrips: 0,
  cooldownUntilSeq: -1,
  retryUntilSeq: -1,
  aboveEmaPrev: false,
};

/** Untung/rugi posisi vs biaya masuk (sudah termasuk fee beli), dalam bps (bigint). */
function unrealizedBps(state: BarsState): bigint | null {
  const pos = state.positions.get(bot.symbol);
  if (pos === undefined || pos.cost === 0n) return null;
  const value = state.value(bot.symbol, pos.qty);
  return ((value - pos.cost) * 10_000n) / pos.cost;
}

/** Jual seluruh posisi yang dipegang. */
function sellAll(state: BarsState): SellInput[] {
  const pos = state.positions.get(bot.symbol);
  if (pos === undefined || pos.qty === 0n) return [];
  bot.mode = 'pendingSell';
  return [{ side: 'sell', symbol: bot.symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

/** Beli all-in: seluruh cash, dibatasi weight room. */
function buyAllIn(state: BarsState): BuyInput[] {
  const room = state.weightRoom(bot.symbol);
  const spend = state.cash < room ? state.cash : room;
  if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  bot.mode = 'pendingBuy';
  return [{ side: 'buy', symbol: bot.symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

// --- Logika per batch ----------------------------------------------------------------

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // 1. Lipat fill dari order batch sebelumnya ke state mesin (harga entry, exit).
  for (const f of batch.fills) {
    if (f.symbol !== bot.symbol) continue;
    if (f.side === 'buy' && bot.mode === 'pendingBuy') {
      if (f.status === 'filled') {
        bot.entryPrice = BigInt(f.price);
        bot.entrySeq = batch.seq;
        const c = state.close(bot.symbol);
        bot.peakClose = c === null ? 0 : Number(c);
        // Bar entry lolos syarat close > EMA(10); lengan cek kelelahan (E).
        bot.aboveEmaPrev = true;
        bot.mode = 'flat'; // mode 'flat' + posisi terpegang = sedang long
      } else {
        bot.mode = 'flat';
        bot.retryUntilSeq = batch.seq + RETRY_BARS;
      }
    } else if (f.side === 'sell' && bot.mode === 'pendingSell') {
      if (f.status === 'filled') {
        bot.roundTrips += 1;
        bot.entryPrice = null;
        bot.peakClose = 0;
        bot.aboveEmaPrev = false;
        bot.cooldownUntilSeq = batch.seq + COOLDOWN_BARS;
      }
      bot.mode = 'flat';
    }
  }

  // 2. Warm-up: order apa pun ditolak; kumpulkan sejarah saja.
  if (state.warmingUp) return [];

  // 3. Catat bar CBBTC (bila ada di batch ini; menit tanpa sampel = tidak ada bar).
  const bar = batch.bars.find((b) => b.symbol === bot.symbol);
  if (bar !== undefined) {
    bot.closes.push(Number(bar.c));
    bot.opens.push(Number(bar.o));
  }
  const close = state.close(bot.symbol);
  if (close === null || bot.closes.length === 0) return [];
  const closeNum = Number(close);
  const holding = (state.positions.get(bot.symbol)?.qty ?? 0n) > 0n;

  // 4. Sisa bar di window terpola (1440 bar; seq dihitung dari awal window terpola).
  const scoredSeq = state.seq - state.warmupBars;
  const remaining = TOTAL_BARS - (scoredSeq + 1);

  // 5. Sedang memegang posisi: hanya exit yang diizinkan (A–E). Tanpa stop-loss.
  if (holding) {
    if (closeNum > bot.peakClose) bot.peakClose = closeNum;
    const up = unrealizedBps(state);
    if (up === null) return [];
    const heldBars = batch.seq - bot.entrySeq;
    const trailDown = bot.peakClose > 0 ? bpsDown(bot.peakClose, closeNum) : 0;
    // (A) Target profit 250 bps.
    if (up >= BigInt(TARGET_BPS)) return sellAll(state);
    // (E) Kelelahan: RSI(14) > 70 DAN close turun di bawah EMA(10) setelah
    // sebelumnya di atas (pembalikan terkonfirmasi) DAN posisi sudah untung.
    // RSI sendirian tidak pernah menjual — itu yang membunuh bot lama.
    const e10Hold = ema(bot.closes, EMA_SHORT);
    const rsiHold = rsi(bot.closes, RSI_PERIOD);
    if (up > 0n && rsiHold > RSI_EXHAUST && closeNum < e10Hold && bot.aboveEmaPrev) return sellAll(state);
    // (B) Posisi basi >= 6 jam dan sudah untung >= 40 bps: panen.
    if (heldBars >= STALE_BARS && up >= BigInt(STALE_MIN_BPS)) return sellAll(state);
    // (C) Trailing 300 bps dari puncak, hanya bila masih untung >= 50 bps.
    if (trailDown >= TRAIL_BPS && up >= BigInt(TRAIL_MIN_BPS)) return sellAll(state);
    // (D) 60 bar terakhir: kunci profit bila sudah untung >= 30 bps.
    if (remaining <= END_SELL_LAST_BARS && up >= BigInt(END_SELL_MIN_BPS)) return sellAll(state);
    // Catat posisi close vs EMA(10) bar ini untuk cek kelelahan bar berikut.
    bot.aboveEmaPrev = closeNum > e10Hold;
    return [];
  }

  // 6. Menunggu fill order yang sudah dikirim: diam.
  if (bot.mode !== 'flat') return [];

  // 7. Gerbang entry (flat, tanpa posisi).
  if (bot.closes.length < HISTORY_MIN_BARS) return [];
  if (remaining <= NO_ENTRY_LAST_BARS) return [];
  if (bot.roundTrips >= MAX_ROUND_TRIPS) return [];
  if (batch.seq < bot.cooldownUntilSeq) return [];
  if (batch.seq < bot.retryUntilSeq) return [];
  if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];

  // 8. Sinyal dip-buy: dip >= 35 bps dari puncak 2 jam, RSI(14) <= 50 dan naik,
  //    close sudah kembali di atas EMA(10) — beli pantulan, bukan pisau jatuh.
  const high = recentHigh(bot.closes, LOOKBACK_HIGH_BARS);
  const dip = bpsDown(high, closeNum);
  if (dip < DIP_BPS) return [];
  const rsiNow = rsi(bot.closes, RSI_PERIOD);
  if (rsiNow > RSI_ENTRY_MAX) return [];
  const rsiPrev = rsi(bot.closes.slice(0, -1), RSI_PERIOD);
  if (rsiNow <= rsiPrev) return [];
  const e10 = ema(bot.closes, EMA_SHORT);
  if (closeNum <= e10) return [];

  return buyAllIn(state);
}

// --- Wire: hello -> batch -> done ------------------------------------------------------

await runBars({
  onHello(state) {
    // Universe hanya satu simbol (CBBTC); ambil dari hello, bukan hardcode.
    if (state.hello.symbols.length > 0) bot.symbol = state.hello.symbols[0]!.symbol;
  },
  onBatch,
  // done: tidak ada yang perlu dilakukan; harness sudah flatten posisi di akhir.
});

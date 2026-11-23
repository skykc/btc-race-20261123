# Stabilised dip-buy cbBTC bot — patient entries, profit-target exits
[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/skykc/btc-race-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/skykc/btc-race-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
Dip-buy sabar ala juara 1 edisi lalu: beli hanya saat harga jatuh ≥35 bps dari puncak 2 jam, RSI(14) ≤50 dan naik, close kembali di atas EMA(10).
Satu posisi, all-in, hold berjam-jam menahan drawdown intraday; jual hanya pada target profit 250 bps, panen posisi basi ≥6 jam, atau trailing 300 bps yang hanya mengunci profit, atau exit kelelahan (RSI>70 + close di bawah EMA(10)).
Tanpa stop-loss yang merealisasikan rugi — itulah yang membunuh bot kami edisi lalu.
Maks 6 round trip, tanpa entry baru di 2 jam terakhir window.
Long only, 1.000 USDC, deterministik penuh (tanpa jam, tanpa acak).
Entry: "Stabilised dip-buy cbBTC bot — patient entries, profit-target exits".
Repo: skykc/btc-race-20261123 — main.ts + vendor/makefun-bars.ts (SDK kit, byte-identik).
Built by my AI agent on make.fun — [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511?ref=6en97dxm)

# P-Quant Lab — HOSE 2020-2026

Bo notebook hoc quant trading P-world tren du lieu that san HOSE:
30 ma thanh khoan + VN-Index + VN30F1M, daily 2020-05 -> 2026-07 (1488 phien aligned,
CSV tung ma co full lich su tu 2018), FPT 1-phut 2 tuan cuoi.
Mo tung file .tenb bang VSCode (Tera kernel) hoac web notebook, chay tu tren xuong.

| # | Notebook | Noi dung | Bai hoc |
|---|---|---|---|
| 01 | market_screen | CAGR/YTD/vol/Sharpe/maxDD 30 ma, correlation, Hurst, CUSUM, BSADF | Nhin thi truong truoc khi nghi chien luoc |
| 02 | volatility_risk | Fat tails, vol clustering, GARCH fit+forecast, VaR/ES, vol targeting, drawdown | Rui ro la thu duy nhat kiem soat duoc |
| 03 | pairs_stat_arb | Quet 435 cap Engle-Granger 6 nam, Kalman hedge, backtest z-score co phi, MinTRL | Stat-arb + ky luat thong ke |
| 04 | momentum_xs | Momentum 1m/3m/6m/12m, walk-forward, PBO, deflated Sharpe, do nhay phi | Chong overfitting |
| 05 | portfolio | Risk parity / HRP / mean-variance vs equal weight | Phan bo von; bay mean-variance in-sample |
| 06 | microstructure | Volume/dollar bars, tick rule, Roll spread, Kyle lambda, VPIN | Goc nhin execution/HFT |
| 07 | tsmom_trend | Time-series momentum 6m-1m long/flat 30 ma vs buy-hold, per-year, phi | Trend following = crisis alpha (xem 2022) |
| 08 | beta_market_neutral | Beta OLS/rolling/Kalman vs VN-Index, hedged returns khong look-ahead | Market-neutral tach alpha khoi beta |
| 09 | calendar_effects | Day-of-week, turn-of-month, sell-in-May + t-tests | Multiple testing: 19 test thi ~1 cai tu trung |
| 10 | market_timing | 200d SMA filter, vol regime, cross-sectional dispersion | Timing giam maxDD; vol du bao vol, khong du bao return |
| 11 | vn30f_basis | Basis VN30F1M vs VN30, ADF/half-life, z-score sentiment | Phai sinh: basis = thuoc do don bay dam dong |
| 12 | research_to_system | Friction waterfall (thue ban, tran/san, T+2.5, vol-sizing), kill-switch, holdout 2025+, LIVE signals | Tu research den he thong dat lenh duoc |
| 13 | ml_alpha | GBM 6 features, shuffle-split leakage vs purged walk-forward + embargo, permutation importance | ML alpha dung cach: 52-55% OOS la thuc te |
| 14 | meta_labeling | Triple-barrier label, meta-model GBM loc tin hieu TSMOM, verdict theo so lieu | Meta-labeling (Lopez de Prado); ket qua am cung la ket qua |
| 15 | factor_portfolios | Factor MOM/LOWVOL monthly long-short, 3-factor regression alpha/beta/R2 | P&L = beta factor + alpha nho; R2 cao = ban dang mua beta |

Du lieu: `data/` — per-ticker CSV (2018+), `panel.csv`/`prices.json` (aligned 2020-05+),
`calendar.csv` (VN-Index + weekday/month/turn-of-month), `vn30_basis.csv` (spot vs futures), `fpt_1m.csv`.
Nguon: DNSE public API, gia da dieu chinh. VNINDEX chi co tu 2020-05 tren nguon nay.

Ghi chu thuc chien:
- 1488 phien phu 4 regime (bull 2021, sap -35% 2022, hoi 2023, sideway phan hoa 2024-26) —
  du cho GARCH / cointegration / backtest; van NHO cho hieu ung lich (can 20+ nam).
- Phi mo phong 15bps/chieu; HOSE thuc te ~10-15bps phi + 10bps thue ban + truot gia.
- HOSE T+2.5, khong short co phieu le: long-short chi minh hoa; thay chan short bang giam ty trong hoac VN30F.

# Master Gold Sweep Pro: MT5 Expert Advisor

`MasterGoldSweepPro.mq5` is an MQL5 port of the TradingView strategy *Master Gold Sweep Pro Engine [Modern HUD + Full FVG + DOL]*. It places and manages its own trades.

## Install

1. In MT5, go to **File → Open Data Folder** and copy `MasterGoldSweepPro.mq5` into `MQL5/Experts/`.
2. Open it in MetaEditor (F4) and click **Compile** (F7).
3. Open an XAUUSD chart on M5 (the HTF anchor then becomes H1) and drag the EA onto it.
4. Turn on **Algo Trading** in the toolbar and tick *Allow Algo Trading* in the EA's settings.

Before going live, run it in the **Strategy Tester** (Ctrl+R) using the *Every tick based on real ticks* model, then on a demo account.

## Settings to check for your broker

| Input | Why |
|---|---|
| `InpServerGMTOffset` / `InpServerUSDST` | Used to convert server time to London and New York time. The defaults (GMT+2, +3 during US DST) fit most brokers. On a live chart the offset is detected automatically; the tester uses these values. |
| `InpUseBrokerTickValue` | Sizes lots from the broker's tick value, so it works whatever the XAUUSD contract size is. Set it to false to use `InpPointValue` (100 = $100 per $1 move per lot), as the Pine script does. |
| `InpMagic` | Use a different magic number for each chart the EA runs on. |

## How it trades

* The engine is evaluated once per closed bar, then a market order goes in on the next bar, as in the Pine strategy.
* **Setup 1 (trend pullback):** a trending regime, a break of structure, and either a bullish (bearish) order block touch or a fresh FVG.
* **Setup 2 (sweep reversal):** a ranging regime, a sweep of the previous day's high or low, then a CISD close within `InpRevWindow` bars.
* **Filters:** HTF MACD bias, no opposing HTF FVG, a confluence score ≥ `InpMinScore`, the news window, and the daily trade and loss limits.
* **Exits:** three positions split 50/30/20 with TP1 at 1.5R, TP2 at 3R, and TP3 at the draw on liquidity (the larger of 5R and the previous-day high/low, or an opposing HTF FVG). The stop moves to break-even after TP1, and a time stop closes the trade after N bars.
* On start-up the EA replays the last `InpWarmupBars` bars so swings, order blocks, FVGs and sweeps are already built. It also restores its daily counters and break-even state after a restart.

## Changes from the Pine script

The Pine code doesn't compile or behave as written in a few places. The EA does the following instead:

* **FVG detection:** `low > high` is always false. The EA uses the standard 3-candle gap: `low > high[2]` (bullish) and `high < low[2]` (bearish).
* **Missing inputs:** `sqPct`, `adxMin` and `beAfterTP1` were never declared. They are now `InpSqueezePct`, `InpAdxMin` and `InpBEAfterTP1`.
* **Lookahead:** `request.security(..., lookahead_on)` reads future HTF and daily data in a backtest. The EA uses only the last *closed* HTF bar and the actual previous day's high and low.
* **Trade tracking:** in the Pine script, entry price and stop were never stored (`if position_size == 0` inside `if position_size != 0`). The EA stores them when the trade opens.
* **Daily loss count:** Pine counts each of the 3 legs as a separate loss, so a single stop-out hit the limit of 2. The EA counts one loss per setup, based on the net result of all its legs.
* **TP3:** set when the trade opens and not recalculated on every bar.
* **Indicators:** MT5's `iATR` uses an SMA where TradingView uses an RMA, so ATR values differ slightly. Volume is tick volume.

Trading is risky. This code isn't financial advice, and past backtest results don't guarantee future performance.

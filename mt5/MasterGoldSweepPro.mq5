//+------------------------------------------------------------------+
//|                                          MasterGoldSweepPro.mq5  |
//|  MT5 Expert Advisor port of the TradingView strategy             |
//|  "Master Gold Sweep Pro Engine [Modern HUD + Full FVG + DOL]".   |
//|                                                                  |
//|  Engine (evaluated once per closed bar of the chart timeframe):  |
//|   - Regime filter: BB-width percentile, ADX(Wilder), Choppiness   |
//|   - Market structure: swing pivots -> BOS/CHoCH                  |
//|   - Volumized order blocks + local fair value gaps               |
//|   - Previous-day high/low liquidity sweeps with CISD reclaim     |
//|   - HTF shield: HTF MACD bias + HTF FVG conflict check           |
//|   - Confluence score gate, session + news window filters         |
//|  Execution: 3-leg bracket (50/30/20) with TP1 1.5R, TP2 3R,      |
//|  TP3 at the draw on liquidity, break-even after TP1, time stop,  |
//|  max trades / max losses per day.                                |
//+------------------------------------------------------------------+
#property copyright   "Ritalee Monde"
#property version     "1.00"
#property description "Auto-trading port of Master Gold Sweep Pro Engine (Pine v6)."

#include <Trade\Trade.mqh>

//--- ① Master signal config
input group "① Master Signal Config"
input int             InpMinScore        = 75;     // Min confluence score (50-95)
input int             InpSwingLen        = 4;      // Swing pivot length (BOS/CHoCH)
input int             InpRevWindow       = 12;     // Sweep reversal: max bars allowed for CISD close

//--- ② HTF shield
input group "② Higher Timeframe (HTF) Shield"
input bool            InpAutoHTF         = true;   // Auto-select HTF anchor from chart period
input ENUM_TIMEFRAMES InpManualHTF       = PERIOD_H1; // Manual HTF anchor (if auto disabled)
input double          InpFvgMinSize      = 0.3;    // Minimum FVG size (x ATR)

//--- ③ Regime filter (referenced but never declared in the Pine script)
input group "③ Regime Filter"
input double          InpSqueezePct      = 20.0;   // BB-width percentile <= this => compression regime
input double          InpAdxMin          = 20.0;   // ADX >= this (and CHOP < 55) => trending regime

//--- ④ Order blocks
input group "④ Institutional Volumized Order Blocks"
input int             InpObCount         = 3;      // Active OB zones tracked per side
input double          InpObMaxATR        = 3.5;    // Max OB zone size (x ATR)
input double          InpVolMult         = 1.3;    // OB minimum volume multiplier (tick volume)

//--- ⑤ Risk management
input group "⑤ Risk Management"
input double          InpRiskPct         = 1.0;    // Risk per trade (% of equity)
input bool            InpUseBrokerTickValue = true; // Size lots from broker tick value (recommended)
input double          InpPointValue      = 100.0;  // $ per 1.0 price move per lot (if above is false)
input double          InpSlBuffer        = 0.25;   // Stop loss ATR padding
input double          InpMaxRiskATR      = 4.5;    // Block entry if stop distance > this x ATR
input double          InpTP1R            = 1.5;    // TP1 (R multiple) - 50% of size
input double          InpTP2R            = 3.0;    // TP2 (R multiple) - 30% of size
input double          InpTP3R            = 5.0;    // TP3 minimum (R multiple) - 20% runner to DOL
input bool            InpBEAfterTP1      = true;   // Move stop to break-even after TP1
input int             InpTimeStopBars    = 60;     // Time stop: close after N bars
input int             InpMaxDayTrades    = 3;      // Max trades per day
input int             InpMaxDayLosses    = 2;      // Max losing trades per day
input double          InpMaxLots         = 50.0;   // Hard cap on total lots per trade

//--- ⑥ Sessions
input group "⑥ Session Constraints"
input string          InpLondonSess      = "0800-1100"; // London session (London local time)
input string          InpNYSess          = "0830-1130"; // New York session (New York local time)
input bool            InpNewsBlock       = true;        // Block entries during US macro window
input string          InpNewsWindow      = "0825-0840"; // US macro window (New York local time)
input bool            InpAutoGMTOffset   = true;        // Live: detect broker GMT offset automatically
input int             InpServerGMTOffset = 2;           // Broker winter GMT offset (tester / manual)
input bool            InpServerUSDST     = true;        // Broker adds +1h during US DST (typical GMT+2/+3)

//--- ⑦ Execution
input group "⑦ Execution"
input long            InpMagic           = 20261021;    // Magic number
input int             InpSlippagePts     = 30;          // Max slippage (points)
input int             InpWarmupBars      = 500;         // History bars replayed on start to build state
input bool            InpShowHUD         = true;        // Show HUD panel

//--- types
struct Zone
  {
   double top;
   double bottom;
  };

struct HtfData
  {
   int    bias;       // 1 bullish, -1 bearish
   bool   bullFvg;
   double bullTop;
   double bullBot;
   bool   bearFvg;
   double bearTop;
   double bearBot;
  };

//--- globals
CTrade          g_trade;
ENUM_TIMEFRAMES g_htf = PERIOD_H1;
int             g_hATR = INVALID_HANDLE, g_hADX = INVALID_HANDLE, g_hBB = INVALID_HANDLE, g_hATRHtf = INVALID_HANDLE;
int             g_ldnStart, g_ldnEnd, g_nyStart, g_nyEnd, g_newsStart, g_newsEnd;

Zone            g_fvgB[], g_fvgS[], g_obB[], g_obS[];

long            g_bar = 0;
long            g_lastDay = -1;
datetime        g_lastProcessed = 0;
datetime        g_lastBarOpen = 0;
bool            g_ready = false;

bool            g_hasSH = false, g_hasSL = false;
double          g_sH = 0, g_sL = 0;
long            g_sHBar = 0, g_sLBar = 0;
bool            g_sHUsed = true, g_sLUsed = true;
int             g_stTrend = 0;

bool            g_swArmL = false, g_swArmS = false;
double          g_swExtL = 0, g_swExtS = 0;
long            g_swBarL = 0, g_swBarS = 0;

int             g_dayTrades = 0, g_dayLosses = 0;
int             g_regime = 2, g_bias = 0;
double          g_netProfit = 0, g_winRate = 0;
string          g_status = "SYSTEM IDLE";
color           g_statusClr = clrSilver;

const string    HUD = "MGS_HUD_";

//+------------------------------------------------------------------+
//| Helpers: zones                                                   |
//+------------------------------------------------------------------+
void ZoneUnshift(Zone &arr[], const double top, const double bottom, const int maxSize)
  {
   int n = ArraySize(arr);
   ArrayResize(arr, n + 1);
   for(int i = n; i > 0; i--)
      arr[i] = arr[i - 1];
   arr[0].top = top;
   arr[0].bottom = bottom;
   if(ArraySize(arr) > maxSize)
      ArrayResize(arr, maxSize);
  }

void ZoneRemove(Zone &arr[], const int idx)
  {
   int n = ArraySize(arr);
   for(int i = idx; i < n - 1; i++)
      arr[i] = arr[i + 1];
   ArrayResize(arr, n - 1);
  }

bool ZoneTouched(const Zone &arr[], const double hi, const double lo)
  {
   for(int i = 0; i < ArraySize(arr); i++)
      if(hi >= arr[i].bottom && lo <= arr[i].top)
         return true;
   return false;
  }

//+------------------------------------------------------------------+
//| Helpers: time zones / sessions                                   |
//+------------------------------------------------------------------+
datetime MakeTime(const int y, const int mon, const int d, const int h)
  {
   MqlDateTime s;
   ZeroMemory(s);
   s.year = y; s.mon = mon; s.day = d; s.hour = h;
   return StructToTime(s);
  }

int DayOfWeek(const datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return s.day_of_week; // 0 = Sunday
  }

datetime NthSunday(const int y, const int mon, const int n, const int hourUtc)
  {
   int dow = DayOfWeek(MakeTime(y, mon, 1, 0));
   int day = 1 + ((7 - dow) % 7) + 7 * (n - 1);
   return MakeTime(y, mon, day, hourUtc);
  }

datetime LastSunday31(const int y, const int mon, const int hourUtc)
  {
   int dow = DayOfWeek(MakeTime(y, mon, 31, 0));
   return MakeTime(y, mon, 31 - dow, hourUtc);
  }

int YearOf(const datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return s.year;
  }

// US DST: 2nd Sunday of March 07:00 UTC -> 1st Sunday of November 06:00 UTC
bool IsUSDST(const datetime utc)
  {
   int y = YearOf(utc);
   return utc >= NthSunday(y, 3, 2, 7) && utc < NthSunday(y, 11, 1, 6);
  }

// EU DST: last Sunday of March 01:00 UTC -> last Sunday of October 01:00 UTC
bool IsEUDST(const datetime utc)
  {
   int y = YearOf(utc);
   return utc >= LastSunday31(y, 3, 1) && utc < LastSunday31(y, 10, 1);
  }

int ServerOffsetSeconds(const datetime serverTime)
  {
   if(InpAutoGMTOffset && !MQLInfoInteger(MQL_TESTER))
     {
      long diff = (long)(TimeTradeServer() - TimeGMT());
      return (int)(MathRound(diff / 900.0) * 900);
     }
   int off = InpServerGMTOffset * 3600;
   if(InpServerUSDST && IsUSDST(serverTime - off))
      off += 3600;
   return off;
  }

int MinuteOfDay(const datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return s.hour * 60 + s.min;
  }

bool ParseSession(const string sess, int &startMin, int &endMin)
  {
   if(StringLen(sess) != 9)
      return false;
   startMin = (int)StringToInteger(StringSubstr(sess, 0, 2)) * 60 + (int)StringToInteger(StringSubstr(sess, 2, 2));
   endMin   = (int)StringToInteger(StringSubstr(sess, 5, 2)) * 60 + (int)StringToInteger(StringSubstr(sess, 7, 2));
   return true;
  }

bool InWindow(const int m, const int startMin, const int endMin)
  {
   if(startMin <= endMin)
      return m >= startMin && m < endMin;
   return m >= startMin || m < endMin;
  }

//+------------------------------------------------------------------+
//| Helpers: prices, volumes                                         |
//+------------------------------------------------------------------+
double NormPrice(const double p)
  {
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(ts <= 0)
      ts = _Point;
   return NormalizeDouble(MathRound(p / ts) * ts, _Digits);
  }

double NormVol(const double v)
  {
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0)
      step = 0.01;
   double out = MathFloor(v / step + 1e-9) * step;
   if(out < vmin)
      return 0.0;
   if(out > vmax)
      out = vmax;
   return NormalizeDouble(out, 8);
  }

double VolAvg(const MqlRates &r[], const int idx)
  {
   double sum = 0;
   for(int i = idx; i < idx + 20; i++)
      sum += (double)r[i].tick_volume;
   return sum / 20.0;
  }

double Cisd(const bool isBull, const MqlRates &r[])
  {
   double ref = 0;
   bool found = false;
   for(int k = 0; k <= 20; k++)
     {
      bool match = isBull ? r[k].close < r[k].open : r[k].close > r[k].open;
      if(match)
        {
         ref = r[k].open;
         found = true;
        }
      else if(found)
         break;
     }
   return found ? ref : EMPTY_VALUE;
  }

string TfName(const ENUM_TIMEFRAMES tf)
  {
   return StringSubstr(EnumToString(tf), 7);
  }

//+------------------------------------------------------------------+
//| Helpers: our positions / persistent trade state                  |
//+------------------------------------------------------------------+
string GvKey(const string field)
  {
   return "MGS_" + _Symbol + "_" + IntegerToString(InpMagic) + "_" + field;
  }

int LegOf(const string comment)
  {
   string parts[];
   if(StringSplit(comment, StringGetCharacter("|", 0), parts) >= 3 && parts[0] == "MGS")
      return (int)StringToInteger(StringSubstr(parts[2], 1));
   return 0;
  }

int OurPositions(ulong &tickets[])
  {
   ArrayResize(tickets, 0);
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol || PositionGetInteger(POSITION_MAGIC) != InpMagic)
         continue;
      int n = ArraySize(tickets);
      ArrayResize(tickets, n + 1);
      tickets[n] = tk;
     }
   return ArraySize(tickets);
  }

bool HasPositions()
  {
   ulong t[];
   return OurPositions(t) > 0;
  }

//+------------------------------------------------------------------+
//| Daily trade / loss counters rebuilt from deal history            |
//| A "trade" is one 3-leg setup; it counts as a loss when all legs  |
//| are closed and their combined net result is negative.           |
//+------------------------------------------------------------------+
void RecountDaily()
  {
   datetime now = TimeCurrent();
   datetime dayStart = (datetime)(((long)now / 86400) * 86400);
   g_dayTrades = 0;
   g_dayLosses = 0;
   if(!HistorySelect(dayStart, now + 60))
      return;

   long   ids[];
   double net[];
   long   posIds[];
   int    posSetup[];
   int    total = HistoryDealsTotal();

   for(int i = 0; i < total; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0 || HistoryDealGetString(d, DEAL_SYMBOL) != _Symbol || HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic)
         continue;
      if(HistoryDealGetInteger(d, DEAL_ENTRY) != DEAL_ENTRY_IN)
         continue;
      // Setup id comes from the order comment; fall back to the open minute if the broker rewrote it
      long id = -1;
      string parts[];
      if(StringSplit(HistoryDealGetString(d, DEAL_COMMENT), StringGetCharacter("|", 0), parts) >= 2 && parts[0] == "MGS")
         id = StringToInteger(parts[1]);
      if(id <= 0)
         id = (long)HistoryDealGetInteger(d, DEAL_TIME) / 60;
      int k = -1;
      for(int j = 0; j < ArraySize(ids); j++)
         if(ids[j] == id) { k = j; break; }
      if(k < 0)
        {
         k = ArraySize(ids);
         ArrayResize(ids, k + 1);
         ArrayResize(net, k + 1);
         ids[k] = id;
         net[k] = 0;
        }
      net[k] += HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_FEE);
      int p = ArraySize(posIds);
      ArrayResize(posIds, p + 1);
      ArrayResize(posSetup, p + 1);
      posIds[p] = HistoryDealGetInteger(d, DEAL_POSITION_ID);
      posSetup[p] = k;
     }

   for(int i = 0; i < total; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0 || HistoryDealGetString(d, DEAL_SYMBOL) != _Symbol || HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic)
         continue;
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY)
         continue;
      long pid = HistoryDealGetInteger(d, DEAL_POSITION_ID);
      for(int p = 0; p < ArraySize(posIds); p++)
         if(posIds[p] == pid)
           {
            net[posSetup[p]] += HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP)
                                + HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_FEE);
            break;
           }
     }

   g_dayTrades = ArraySize(ids);
   for(int k = 0; k < ArraySize(ids); k++)
     {
      bool stillOpen = false;
      for(int p = 0; p < ArraySize(posIds); p++)
         if(posSetup[p] == k && PositionSelectByTicket((ulong)posIds[p]))
           {
            stillOpen = true;
            break;
           }
      if(!stillOpen && net[k] < 0)
         g_dayLosses++;
     }
  }

// Net P/L and win rate of every closed leg this EA has traded (HUD only)
void UpdateStats()
  {
   g_netProfit = 0;
   g_winRate = 0;
   if(!HistorySelect(0, TimeCurrent() + 60))
      return;
   int closed = 0, wins = 0;
   for(int i = 0; i < HistoryDealsTotal(); i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0 || HistoryDealGetString(d, DEAL_SYMBOL) != _Symbol || HistoryDealGetInteger(d, DEAL_MAGIC) != InpMagic)
         continue;
      double v = HistoryDealGetDouble(d, DEAL_PROFIT) + HistoryDealGetDouble(d, DEAL_SWAP)
                 + HistoryDealGetDouble(d, DEAL_COMMISSION) + HistoryDealGetDouble(d, DEAL_FEE);
      g_netProfit += v;
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
        {
         closed++;
         if(v > 0)
            wins++;
        }
     }
   if(closed > 0)
      g_winRate = 100.0 * wins / closed;
  }

//+------------------------------------------------------------------+
//| HTF data as of the close of the signal bar (no lookahead)        |
//+------------------------------------------------------------------+
bool ReadHtf(const datetime barTime, HtfData &h)
  {
   datetime closeT = barTime + PeriodSeconds(_Period);
   int hs = iBarShift(_Symbol, g_htf, closeT, false);
   if(hs < 0)
      return false;
   datetime ht = iTime(_Symbol, g_htf, hs);
   if(ht == 0)
      return false;
   if(ht + PeriodSeconds(g_htf) > closeT)
      hs++; // that HTF bar was still forming -> use the previous, fully closed one

   MqlRates hr[];
   ArraySetAsSeries(hr, true);
   if(CopyRates(_Symbol, g_htf, hs, 3, hr) < 3)
      return false;
   double ab[];
   if(CopyBuffer(g_hATRHtf, 0, hs, 1, ab) < 1)
      return false;

   double minGap = ab[0] * InpFvgMinSize;
   h.bullFvg = hr[0].low > hr[2].high && (hr[0].low - hr[2].high) >= minGap;
   h.bullTop = hr[0].low;
   h.bullBot = hr[2].high;
   h.bearFvg = hr[0].high < hr[2].low && (hr[2].low - hr[0].high) >= minGap;
   h.bearTop = hr[2].low;
   h.bearBot = hr[0].high;

   // MACD(12,26,9) with EMA signal line, like Pine's ta.macd
   double c[];
   int n = CopyClose(_Symbol, g_htf, hs, 300, c); // oldest first
   if(n < 60)
      return false;
   double a12 = 2.0 / 13.0, a26 = 2.0 / 27.0, a9 = 2.0 / 10.0;
   double e12 = c[0], e26 = c[0], sig = 0, macd = 0;
   for(int i = 0; i < n; i++)
     {
      e12 = a12 * c[i] + (1 - a12) * e12;
      e26 = a26 * c[i] + (1 - a26) * e26;
      macd = e12 - e26;
      sig = (i == 0) ? macd : a9 * macd + (1 - a9) * sig;
     }
   h.bias = macd > sig ? 1 : -1;
   return true;
  }

//+------------------------------------------------------------------+
//| Order-block search after a structure break                       |
//+------------------------------------------------------------------+
void BuildOB(const bool bull, const MqlRates &r[], const double atr)
  {
   long refBar = bull ? (g_hasSL ? g_sLBar : g_bar - 10) : (g_hasSH ? g_sHBar : g_bar - 10);
   int lookback = (int)MathMin(MathMax(g_bar - refBar, 1), 40);
   int idx = -1;
   for(int k = 1; k <= lookback; k++)
     {
      if(bull && r[k].close < r[k].open && (idx < 0 || r[k].low < r[idx].low))
         idx = k;
      if(!bull && r[k].close > r[k].open && (idx < 0 || r[k].high > r[idx].high))
         idx = k;
     }
   if(idx < 0)
      return;
   if(r[idx].high - r[idx].low > atr * InpObMaxATR)
      return;
   if((double)r[idx].tick_volume <= VolAvg(r, idx) * InpVolMult)
      return;
   if(bull)
      ZoneUnshift(g_obB, r[idx].high, r[idx].low, InpObCount);
   else
      ZoneUnshift(g_obS, r[idx].high, r[idx].low, InpObCount);
  }

//+------------------------------------------------------------------+
//| Status line                                                      |
//+------------------------------------------------------------------+
void SetStatus(const string msg, const color clr)
  {
   g_status = msg;
   g_statusClr = clr;
  }

bool PlaceBracket(const int dir, const double stopRaw, const int score, const double atr,
                  const double pdh, const double pdl, const HtfData &h, const long setupId);

//+------------------------------------------------------------------+
//| Run the full engine on one closed bar (shift s).                 |
//| allowTrade = false during the history warm-up replay.            |
//+------------------------------------------------------------------+
bool ProcessBar(const int s, const bool allowTrade)
  {
   const int N = 200;
   MqlRates r[];
   ArraySetAsSeries(r, true);
   if(CopyRates(_Symbol, _Period, s, N, r) < N)
      return false;

   double atrB[], adxB[], bbM[], bbU[], bbL[];
   ArraySetAsSeries(bbM, true);
   ArraySetAsSeries(bbU, true);
   ArraySetAsSeries(bbL, true);
   if(CopyBuffer(g_hATR, 0, s, 1, atrB) < 1)
      return false;
   if(CopyBuffer(g_hADX, 0, s, 1, adxB) < 1)
      return false;
   if(CopyBuffer(g_hBB, BASE_LINE, s, 121, bbM) < 121 ||
      CopyBuffer(g_hBB, UPPER_BAND, s, 121, bbU) < 121 ||
      CopyBuffer(g_hBB, LOWER_BAND, s, 121, bbL) < 121)
      return false;

   const datetime t = r[0].time;
   HtfData h;
   if(!ReadHtf(t, h))
      return false;

   int ds = iBarShift(_Symbol, PERIOD_D1, t, false);
   if(ds < 0)
      return false;
   double pdh = iHigh(_Symbol, PERIOD_D1, ds + 1);
   double pdl = iLow(_Symbol, PERIOD_D1, ds + 1);
   if(pdh <= 0 || pdl <= 0)
      return false;

   //--- bar bookkeeping
   g_bar++;
   long day = (long)(t / 86400);
   bool newDay = g_lastDay >= 0 && day != g_lastDay;
   g_lastDay = day;
   g_lastProcessed = t;

   const double atr = atrB[0];
   const double cl = r[0].close, hi = r[0].high, lo = r[0].low;
   const bool intraday = PeriodSeconds(_Period) < 86400;

   //--- sessions (bar open time converted to London / New York local time)
   datetime utc = t - ServerOffsetSeconds(t);
   int ldnMin = MinuteOfDay(utc + (IsEUDST(utc) ? 3600 : 0));
   int nyMin  = MinuteOfDay(utc - 5 * 3600 + (IsUSDST(utc) ? 3600 : 0));
   bool inSess = InWindow(ldnMin, g_ldnStart, g_ldnEnd) || InWindow(nyMin, g_nyStart, g_nyEnd);
   bool inNewsBlock = InpNewsBlock && InWindow(nyMin, g_newsStart, g_newsEnd);

   //--- local fair value gaps (3-candle gap: bar 0 vs bar 2)
   bool fvgB = lo > r[2].high && (lo - r[2].high) >= atr * InpFvgMinSize;
   bool fvgS = hi < r[2].low && (r[2].low - hi) >= atr * InpFvgMinSize;
   if(fvgB && intraday)
      ZoneUnshift(g_fvgB, lo, r[2].high, 5);
   if(fvgS && intraday)
      ZoneUnshift(g_fvgS, r[2].low, hi, 5);
   for(int i = ArraySize(g_fvgB) - 1; i >= 0; i--)
      if(cl < g_fvgB[i].bottom || newDay)
         ZoneRemove(g_fvgB, i);
   for(int i = ArraySize(g_fvgS) - 1; i >= 0; i--)
      if(cl > g_fvgS[i].top || newDay)
         ZoneRemove(g_fvgS, i);

   bool inHtfBullFvg = h.bullFvg && lo <= h.bullTop && hi >= h.bullBot;
   bool inHtfBearFvg = h.bearFvg && hi >= h.bearBot && lo <= h.bearTop;
   g_bias = h.bias;

   //--- regime: BB-width percentile, ADX, choppiness
   double bbw0 = bbM[0] != 0 ? (bbU[0] - bbL[0]) / bbM[0] : 0.0;
   int below = 0;
   for(int i = 1; i <= 120; i++)
     {
      double w = bbM[i] != 0 ? (bbU[i] - bbL[i]) / bbM[i] : 0.0;
      if(w <= bbw0)
         below++;
     }
   double bbRank = 100.0 * below / 120.0;

   double trSum = 0, hh = r[0].high, ll = r[0].low;
   for(int i = 0; i < 14; i++)
     {
      trSum += MathMax(r[i].high, r[i + 1].close) - MathMin(r[i].low, r[i + 1].close);
      hh = MathMax(hh, r[i].high);
      ll = MathMin(ll, r[i].low);
     }
   double chopRng = hh - ll;
   double chop = chopRng > 0 ? 100.0 * MathLog10(trSum / chopRng) / MathLog10(14.0) : 50.0;
   g_regime = bbRank <= InpSqueezePct ? 3 : (adxB[0] >= InpAdxMin && chop < 55 ? 1 : 2);

   double volAvg = VolAvg(r, 0);
   bool volBig = (double)r[0].tick_volume > volAvg * InpVolMult;
   double rng = hi - lo;
   bool absBull = volBig && rng > 0 && (MathMin(r[0].open, cl) - lo >= rng * 0.4);
   bool absBear = volBig && rng > 0 && (hi - MathMax(r[0].open, cl) >= rng * 0.4);

   //--- market structure: pivots confirmed InpSwingLen bars later
   int c = InpSwingLen;
   bool isPH = true, isPL = true;
   for(int i = 1; i <= InpSwingLen; i++)
     {
      if(r[c + i].high >= r[c].high || r[c - i].high > r[c].high)
         isPH = false;
      if(r[c + i].low <= r[c].low || r[c - i].low < r[c].low)
         isPL = false;
     }
   if(isPH)
     {
      g_sH = r[c].high; g_sHBar = g_bar - InpSwingLen; g_sHUsed = false; g_hasSH = true;
     }
   if(isPL)
     {
      g_sL = r[c].low; g_sLBar = g_bar - InpSwingLen; g_sLUsed = false; g_hasSL = true;
     }

   bool brkUp = g_hasSH && !g_sHUsed && cl > g_sH;
   bool brkDn = g_hasSL && !g_sLUsed && cl < g_sL;
   if(brkUp)
     {
      g_sHUsed = true;
      g_stTrend = 1;
     }
   if(brkDn)
     {
      g_sLUsed = true;
      g_stTrend = -1;
     }

   //--- volumized order blocks
   if(brkUp)
      BuildOB(true, r, atr);
   if(brkDn)
      BuildOB(false, r, atr);
   for(int i = ArraySize(g_obB) - 1; i >= 0; i--)
      if(cl < g_obB[i].bottom)
         ZoneRemove(g_obB, i);
   for(int i = ArraySize(g_obS) - 1; i >= 0; i--)
      if(cl > g_obS[i].top)
         ZoneRemove(g_obS, i);
   bool bullOBTouched = ZoneTouched(g_obB, hi, lo);
   bool bearOBTouched = ZoneTouched(g_obS, hi, lo);

   //--- setup 1: trend pullback continuation
   bool localPbBuy  = g_regime == 1 && (bullOBTouched || fvgB) && brkUp;
   bool localPbSell = g_regime == 1 && (bearOBTouched || fvgS) && brkDn;

   //--- setup 2: previous-day liquidity sweep + CISD reclaim
   bool sweepL = lo < pdl && cl > pdl;
   bool sweepS = hi > pdh && cl < pdh;
   if(sweepL && !g_swArmL)
     {
      g_swArmL = true; g_swExtL = lo; g_swBarL = g_bar;
     }
   else if(g_swArmL && lo < g_swExtL)
      g_swExtL = lo;
   if(sweepS && !g_swArmS)
     {
      g_swArmS = true; g_swExtS = hi; g_swBarS = g_bar;
     }
   else if(g_swArmS && hi > g_swExtS)
      g_swExtS = hi;
   if((g_swArmL && g_bar - g_swBarL > InpRevWindow) || newDay)
      g_swArmL = false;
   if((g_swArmS && g_bar - g_swBarS > InpRevWindow) || newDay)
      g_swArmS = false;

   double cisdL = Cisd(true, r);
   double cisdS = Cisd(false, r);
   bool sweepRevBuy  = g_regime == 2 && g_swArmL && cisdL != EMPTY_VALUE && cl > cisdL;
   bool sweepRevSell = g_regime == 2 && g_swArmS && cisdS != EMPTY_VALUE && cl < cisdS;

   //--- HTF shield
   bool allowLong  = h.bias == 1 && !inHtfBearFvg;
   bool allowShort = h.bias == -1 && !inHtfBullFvg;

   if(allowTrade)
      RecountDaily();
   bool limitsOk = g_dayTrades < InpMaxDayTrades && g_dayLosses < InpMaxDayLosses;

   //--- trigger selection
   int dir = 0, setup = 0;
   double stop = 0;
   if(!inNewsBlock && limitsOk)
     {
      if(localPbBuy && allowLong && g_hasSL)
        { dir = 1; setup = 1; stop = g_sL - atr * InpSlBuffer; }
      else if(localPbSell && allowShort && g_hasSH)
        { dir = -1; setup = 1; stop = g_sH + atr * InpSlBuffer; }
      else if(sweepRevBuy && allowLong)
        { dir = 1; setup = 2; stop = g_swExtL - atr * InpSlBuffer; g_swArmL = false; }
      else if(sweepRevSell && allowShort)
        { dir = -1; setup = 2; stop = g_swExtS + atr * InpSlBuffer; g_swArmS = false; }
     }

   //--- confluence score
   int score = 0;
   if(dir != 0)
     {
      score = 30;
      score += h.bias == dir ? 25 : -15;
      if(setup == 1 && ((dir == 1 && ArraySize(g_fvgB) > 0) || (dir == -1 && ArraySize(g_fvgS) > 0)))
         score += 15;
      score += inSess ? 20 : -10;
      if((dir == 1 && absBull) || (dir == -1 && absBear))
         score += 10;
      score = (int)MathMax(0, MathMin(100, score));
     }

   if(!allowTrade)
      return true;

   bool inPos = HasPositions();
   if(dir != 0 && score >= InpMinScore && !inPos)
     {
      PlaceBracket(dir, stop, score, atr, pdh, pdl, h, (long)t);
      return true;
     }

   if(!inPos)
     {
      if(!limitsOk)
         SetStatus("DAILY LIMIT REACHED - ENTRIES LOCKED UNTIL NEXT SESSION", clrOrange);
      else if(inNewsBlock)
         SetStatus("ENTRY SENSORS PAUSED - US MACRO VOLATILITY WINDOW", clrMagenta);
      else if(g_swArmL || g_swArmS)
         SetStatus("LIQUIDITY SWEPT - AWAITING MARKET RECLAIM (CISD CLOSE)", clrAqua);
      else
         SetStatus("SCANNING LIQUIDITY ARRAYS FOR INSTITUTIONAL CONFLUENCE", clrSilver);
     }
   return true;
  }

//+------------------------------------------------------------------+
//| Position sizing                                                  |
//+------------------------------------------------------------------+
double CalcLots(const double riskDist)
  {
   double riskMoney = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPct / 100.0;
   double lossPerLot;
   if(InpUseBrokerTickValue)
     {
      double tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
      if(tv <= 0)
         tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      if(tv <= 0 || ts <= 0)
         return 0;
      lossPerLot = riskDist / ts * tv;
     }
   else
      lossPerLot = riskDist * InpPointValue;
   if(lossPerLot <= 0)
      return 0;
   return MathMin(riskMoney / lossPerLot, InpMaxLots);
  }

//+------------------------------------------------------------------+
//| Open the 3-leg bracket: 50% @ TP1, 30% @ TP2, 20% runner @ DOL   |
//+------------------------------------------------------------------+
bool PlaceBracket(const int dir, const double stopRaw, const int score, const double atr,
                  const double pdh, const double pdl, const HtfData &h, const long setupId)
  {
   MqlTick tk;
   if(!SymbolInfoTick(_Symbol, tk))
      return false;
   double price = dir > 0 ? tk.ask : tk.bid;
   double stop = NormPrice(stopRaw);
   double risk = dir > 0 ? price - stop : stop - price;
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;

   if(risk <= 0 || risk <= minDist)
     {
      SetStatus("STOP ON WRONG SIDE / TOO CLOSE - ENTRY BLOCKED", clrOrange);
      return false;
     }
   if(risk > atr * InpMaxRiskATR)
     {
      SetStatus("RISK THRESHOLD EXCEEDED - ENTRY BLOCKED", clrOrange);
      return false;
     }

   double lots = CalcLots(risk);
   double raw[3];
   raw[0] = lots * 0.5; raw[1] = lots * 0.3; raw[2] = lots * 0.2;
   double vol[3];
   double sum = 0;
   for(int i = 0; i < 3; i++)
     {
      vol[i] = NormVol(raw[i]);
      sum += vol[i];
     }
   // Give whatever was lost to rounding / minimum-lot limits to the first leg
   if(lots - sum > 0)
      vol[0] = NormVol(vol[0] + (lots - sum));
   if(vol[0] + vol[1] + vol[2] <= 0)
     {
      SetStatus("POSITION SIZE BELOW BROKER MINIMUM - ENTRY BLOCKED", clrOrange);
      return false;
     }

   double margin = 0;
   if(OrderCalcMargin(dir > 0 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, _Symbol, vol[0] + vol[1] + vol[2], price, margin) &&
      margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE))
     {
      SetStatus("INSUFFICIENT FREE MARGIN - ENTRY BLOCKED", clrOrange);
      return false;
     }

   double tp[3];
   tp[0] = price + dir * risk * InpTP1R;
   tp[1] = price + dir * risk * InpTP2R;
   tp[2] = dir > 0 ? MathMax(pdh, price + risk * InpTP3R) : MathMin(pdl, price - risk * InpTP3R);
   // Draw on liquidity: an opposing HTF FVG beyond TP1 becomes the runner's target
   if(dir > 0 && h.bearFvg && h.bearBot > tp[0])
      tp[2] = h.bearBot;
   if(dir < 0 && h.bullFvg && h.bullTop < tp[0])
      tp[2] = h.bullTop;

   int opened = 0;
   for(int i = 0; i < 3; i++)
     {
      if(vol[i] <= 0)
         continue;
      string cmt = StringFormat("MGS|%I64d|L%d|S%d", setupId, i + 1, score);
      bool ok = dir > 0 ? g_trade.Buy(vol[i], _Symbol, 0.0, stop, NormPrice(tp[i]), cmt)
                        : g_trade.Sell(vol[i], _Symbol, 0.0, stop, NormPrice(tp[i]), cmt);
      if(ok && (g_trade.ResultRetcode() == TRADE_RETCODE_DONE || g_trade.ResultRetcode() == TRADE_RETCODE_PLACED))
         opened++;
      else
         PrintFormat("MGS: leg %d failed, retcode %u (%s)", i + 1, g_trade.ResultRetcode(), g_trade.ResultRetcodeDescription());
     }
   if(opened == 0)
     {
      SetStatus("ORDER REJECTED BY BROKER - SEE EXPERTS LOG", clrRed);
      return false;
     }

   GlobalVariableSet(GvKey("entry"), price);
   GlobalVariableSet(GvKey("tp1"), tp[0]);
   GlobalVariableSet(GvKey("dir"), dir);
   GlobalVariableSet(GvKey("hasL1"), vol[0] > 0 ? 1 : 0);
   GlobalVariableSet(GvKey("be"), 0);

   SetStatus(StringFormat("EXECUTING %s HOLD SETUP (Score: %d)", dir > 0 ? "LONG" : "SHORT", score), dir > 0 ? clrLime : clrRed);
   PrintFormat("MGS: %s setup %I64d score %d lots %.2f/%.2f/%.2f SL %.2f TP %.2f/%.2f/%.2f",
               dir > 0 ? "LONG" : "SHORT", setupId, score, vol[0], vol[1], vol[2], stop, tp[0], tp[1], tp[2]);
   RecountDaily();
   return true;
  }

//+------------------------------------------------------------------+
//| Per-tick management: break-even after TP1 and time stop          |
//+------------------------------------------------------------------+
void ManagePositions()
  {
   ulong tickets[];
   int n = OurPositions(tickets);
   if(n == 0)
     {
      if(GlobalVariableCheck(GvKey("entry")))
        {
         GlobalVariableDel(GvKey("entry"));
         GlobalVariableDel(GvKey("tp1"));
         GlobalVariableDel(GvKey("dir"));
         GlobalVariableDel(GvKey("hasL1"));
         GlobalVariableDel(GvKey("be"));
         RecountDaily();
         UpdateStats();
        }
      return;
     }

   //--- time stop, counted in chart bars since the earliest leg opened
   datetime opened = 0;
   for(int i = 0; i < n; i++)
      if(PositionSelectByTicket(tickets[i]))
        {
         datetime pt = (datetime)PositionGetInteger(POSITION_TIME);
         if(opened == 0 || pt < opened)
            opened = pt;
        }
   int barsIn = iBarShift(_Symbol, _Period, opened, false);
   if(barsIn >= InpTimeStopBars)
     {
      for(int i = 0; i < n; i++)
         g_trade.PositionClose(tickets[i]);
      SetStatus("TRADE RECLAIMED BY SESSION TIME-STOP", clrOrange);
      return;
     }

   //--- break-even after TP1
   if(!InpBEAfterTP1 || !GlobalVariableCheck(GvKey("entry")) || GlobalVariableGet(GvKey("be")) > 0)
      return;
   double entry = GlobalVariableGet(GvKey("entry"));
   double tp1   = GlobalVariableGet(GvKey("tp1"));
   int    dir   = (int)GlobalVariableGet(GvKey("dir"));
   bool   hadL1 = GlobalVariableGet(GvKey("hasL1")) > 0;

   bool leg1Open = false;
   for(int i = 0; i < n; i++)
      if(PositionSelectByTicket(tickets[i]) && LegOf(PositionGetString(POSITION_COMMENT)) == 1)
         leg1Open = true;

   MqlTick tk;
   if(!SymbolInfoTick(_Symbol, tk))
      return;
   bool tp1Hit = (dir > 0 ? tk.bid >= tp1 : tk.ask <= tp1) || (hadL1 && !leg1Open);
   if(!tp1Hit)
      return;

   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   double be = NormPrice(entry);
   bool allDone = true;
   for(int i = 0; i < n; i++)
     {
      if(!PositionSelectByTicket(tickets[i]))
         continue;
      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      bool improves = dir > 0 ? (sl < be) : (sl == 0 || sl > be);
      if(!improves)
         continue;
      bool valid = dir > 0 ? (be < tk.bid - minDist) : (be > tk.ask + minDist);
      if(!valid || !g_trade.PositionModify(tickets[i], be, tp))
         allDone = false;
     }
   if(allDone)
     {
      GlobalVariableSet(GvKey("be"), 1);
      SetStatus("TP1 EXECUTED - MARGIN GUARD ADVANCED TO BREAKEVEN", clrYellow);
     }
  }

//+------------------------------------------------------------------+
//| HUD                                                              |
//+------------------------------------------------------------------+
void HudText(const string id, const int x, const int y, const string text, const color clr, const int size = 8)
  {
   string name = HUD + id;
   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_ANCHOR, ANCHOR_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
     }
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, size);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
  }

void DrawHUD()
  {
   if(!InpShowHUD)
      return;
   if(MQLInfoInteger(MQL_TESTER) && !MQLInfoInteger(MQL_VISUAL_MODE))
      return;

   const int x0 = 12, y0 = 24, w = 520, rowH = 18;
   string bg = HUD + "bg";
   if(ObjectFind(0, bg) < 0)
     {
      ObjectCreate(0, bg, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, bg, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, bg, OBJPROP_XDISTANCE, x0 - 6);
      ObjectSetInteger(0, bg, OBJPROP_YDISTANCE, y0 - 6);
      ObjectSetInteger(0, bg, OBJPROP_XSIZE, w);
      ObjectSetInteger(0, bg, OBJPROP_YSIZE, rowH * 6 + 10);
      ObjectSetInteger(0, bg, OBJPROP_BGCOLOR, C'13,17,23');
      ObjectSetInteger(0, bg, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, bg, OBJPROP_COLOR, C'48,54,61');
      ObjectSetInteger(0, bg, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, bg, OBJPROP_HIDDEN, true);
     }

   const int c1 = x0, c2 = x0 + 130, c3 = x0 + 270, c4 = x0 + 400;
   string regime = g_regime == 1 ? "TRENDING LEG" : g_regime == 3 ? "COMPRESSION SQUEEZE" : "LIQUIDITY RANGE";
   color regimeClr = g_regime == 1 ? clrLime : g_regime == 3 ? clrAqua : clrYellow;

   HudText("title", c1, y0, "CORE ORDER FLOW SYSTEM  |  Master Gold Sweep Pro", clrWhite, 9);

   HudText("k1", c1, y0 + rowH, "MARKET REGIME:", clrSilver);
   HudText("v1", c2, y0 + rowH, regime, regimeClr);
   HudText("k2", c3, y0 + rowH, "ANCHOR TF:", clrSilver);
   HudText("v2", c4, y0 + rowH, TfName(g_htf) + " engine", clrOrange);

   HudText("k3", c1, y0 + rowH * 2, "MACRO BIAS:", clrSilver);
   HudText("v3", c2, y0 + rowH * 2, g_bias == 1 ? "INSTITUTIONAL BULLISH" : g_bias == -1 ? "INSTITUTIONAL BEARISH" : "-", g_bias == 1 ? clrLime : clrRed);
   HudText("k4", c3, y0 + rowH * 2, "RISK / TRADE:", clrSilver);
   HudText("v4", c4, y0 + rowH * 2, DoubleToString(InpRiskPct, 1) + "% of equity", clrWhite);

   HudText("k5", c1, y0 + rowH * 3, "TRADES TODAY:", clrSilver);
   HudText("v5", c2, y0 + rowH * 3, IntegerToString(g_dayTrades) + " / " + IntegerToString(InpMaxDayTrades), clrWhite);
   HudText("k6", c3, y0 + rowH * 3, "LOSSES TODAY:", clrSilver);
   HudText("v6", c4, y0 + rowH * 3, IntegerToString(g_dayLosses) + " / " + IntegerToString(InpMaxDayLosses), g_dayLosses >= InpMaxDayLosses ? clrRed : clrWhite);

   HudText("k7", c1, y0 + rowH * 4, "NET EA PnL:", clrSilver);
   HudText("v7", c2, y0 + rowH * 4, "$" + DoubleToString(g_netProfit, 2), g_netProfit >= 0 ? clrLime : clrRed);
   HudText("k8", c3, y0 + rowH * 4, "WIN RATE:", clrSilver);
   HudText("v8", c4, y0 + rowH * 4, DoubleToString(g_winRate, 1) + "% WR", clrWhite);

   HudText("status", c1, y0 + rowH * 5, "STATUS >> " + g_status, g_statusClr, 9);
   ChartRedraw();
  }

//+------------------------------------------------------------------+
//| State reset + history warm-up                                    |
//+------------------------------------------------------------------+
void ResetState()
  {
   ArrayResize(g_fvgB, 0);
   ArrayResize(g_fvgS, 0);
   ArrayResize(g_obB, 0);
   ArrayResize(g_obS, 0);
   g_bar = 0; g_lastDay = -1; g_lastProcessed = 0;
   g_hasSH = false; g_hasSL = false; g_sHUsed = true; g_sLUsed = true; g_stTrend = 0;
   g_swArmL = false; g_swArmS = false;
  }

bool WarmUp()
  {
   ResetState();
   int avail = Bars(_Symbol, _Period);
   int start = MathMin(InpWarmupBars, avail - 260);
   if(start < 2)
      return false;
   for(int s = start; s >= 2; s--)
      ProcessBar(s, false);
   if(!ProcessBar(1, false)) // the latest closed bar must be readable (HTF / D1 history synced)
      return false;
   g_lastBarOpen = iTime(_Symbol, _Period, 0);
   g_ready = true;
   RecountDaily();
   UpdateStats();
   SetStatus("SCANNING LIQUIDITY ARRAYS FOR INSTITUTIONAL CONFLUENCE", clrSilver);
   Print("MGS: warm-up complete, HTF anchor ", TfName(g_htf));
   return true;
  }

//+------------------------------------------------------------------+
//| Expert initialization                                            |
//+------------------------------------------------------------------+
int OnInit()
  {
   if(!ParseSession(InpLondonSess, g_ldnStart, g_ldnEnd) ||
      !ParseSession(InpNYSess, g_nyStart, g_nyEnd) ||
      !ParseSession(InpNewsWindow, g_newsStart, g_newsEnd))
     {
      Print("MGS: sessions must be formatted HHMM-HHMM");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpSwingLen < 2 || InpSwingLen > 10 || InpMinScore < 50 || InpMinScore > 95 || InpRiskPct <= 0)
      return INIT_PARAMETERS_INCORRECT;

   if(InpAutoHTF)
     {
      int sec = PeriodSeconds(_Period);
      g_htf = sec <= 300 ? PERIOD_H1 : sec <= 1800 ? PERIOD_H4 : sec < 86400 ? PERIOD_D1 : PERIOD_W1;
     }
   else
      g_htf = InpManualHTF;

   g_hATR    = iATR(_Symbol, _Period, 14);
   g_hADX    = iADXWilder(_Symbol, _Period, 14);
   g_hBB     = iBands(_Symbol, _Period, 20, 0, 2.0, PRICE_CLOSE);
   g_hATRHtf = iATR(_Symbol, g_htf, 14);
   if(g_hATR == INVALID_HANDLE || g_hADX == INVALID_HANDLE || g_hBB == INVALID_HANDLE || g_hATRHtf == INVALID_HANDLE)
     {
      Print("MGS: failed to create indicator handles");
      return INIT_FAILED;
     }

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePts);
   g_trade.SetTypeFillingBySymbol(_Symbol);

   g_ready = false;
   DrawHUD();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   IndicatorRelease(g_hATR);
   IndicatorRelease(g_hADX);
   IndicatorRelease(g_hBB);
   IndicatorRelease(g_hATRHtf);
   ObjectsDeleteAll(0, HUD);
   ChartRedraw();
  }

//+------------------------------------------------------------------+
//| Tick handler                                                     |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(!g_ready)
     {
      if(!WarmUp())
         return;
     }

   datetime cur = iTime(_Symbol, _Period, 0);
   if(cur != 0 && cur != g_lastBarOpen)
     {
      // Process every bar that closed since the last one handled (normally exactly one)
      int sLast = iBarShift(_Symbol, _Period, g_lastProcessed, true);
      if(sLast < 2)
         sLast = 2;
      bool ok = true;
      for(int s = sLast - 1; s >= 1 && ok; s--)
         ok = ProcessBar(s, s == 1);
      if(ok)
        {
         g_lastBarOpen = cur;
         UpdateStats();
        }
     }

   ManagePositions();
   DrawHUD();
  }
//+------------------------------------------------------------------+

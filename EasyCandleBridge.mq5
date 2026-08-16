//+------------------------------------------------------------------+
//| EasyCandleBridge.mq5                                             |
//|                                                                  |
//| Streams MetaTrader 5 data (real-time ticks, live bars, historical|
//| candles) to the Easy Candle desktop app over a local WebSocket.  |
//|                                                                  |
//| 1. Start the bridge in Easy Candle (MetaTrader panel).           |
//| 2. Attach this EA to a chart for each symbol you want live data. |
//| 3. Live ticks/bars stream for the chart symbol. History requests |
//|    work for any symbol available in the terminal.                |
//|                                                                  |
//| Pure MQL5 WebSocket client (RFC 6455) — no DLLs.                 |
//+------------------------------------------------------------------+
#property copyright "Easy Candle"
#property version "1.00"
#property description "Streams ticks, live bars and history to Easy Candle via local WebSocket."

#include <Trade/AccountInfo.mqh>

//--- inputs -------------------------------------------------------------------
input group "Easy Candle connection"
input bool   InpEnable           = true;       // Enable bridge
input string InpHost             = "127.0.0.1"; // Host
input int    InpPort             = 8787;        // Port
input int    InpReconnectSeconds = 5;           // Reconnect after (seconds)

input group "Live streaming (chart symbol)"
input string InpTimeframes  = "M1,M5,M15"; // Live bar timeframes (comma separated)
input int    InpTickMs      = 100;         // Min ms between tick messages
input int    InpBarMs       = 500;         // Min ms between forming-bar updates

//--- WebSocket opcodes ---------------------------------------------------------
#define WS_OP_CONT   0
#define WS_OP_TEXT   1
#define WS_OP_BINARY 2
#define WS_OP_CLOSE  8
#define WS_OP_PING   9
#define WS_OP_PONG   10
#define WS_MASK      0x80

#define MAX_RECV_CHUNK 8192
#define MAX_RECV_TOTAL (16 * 1024 * 1024)
#define MAX_BARS_PER_RESPONSE 200000

//--- state ---------------------------------------------------------------------
enum WsState
  {
   WS_IDLE,
   WS_CONNECTING,
   WS_OPEN
  };

int    g_socket = INVALID_HANDLE;
WsState g_state = WS_IDLE;
bool   g_handshakeDone = false;
bool   g_live = true;
uint   g_lastConnectAttempt = 0;
uint   g_lastTickSent = 0;
uint   g_lastPingAt = 0;
uchar  g_recv[];

ENUM_TIMEFRAMES g_subscribedTimeframes[];
datetime        g_lastBarOpen[];
uint            g_lastBarSentAt[];

//+------------------------------------------------------------------+
//| Timeframe helpers                                                |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES TimeframeFromId(string id)
  {
   StringToUpper(id);
   if(id == "M1"  || id == "1M")  return PERIOD_M1;
   if(id == "M5"  || id == "5M")  return PERIOD_M5;
   if(id == "M15" || id == "15M") return PERIOD_M15;
   if(id == "H1"  || id == "1H")  return PERIOD_H1;
   if(id == "H4"  || id == "4H")  return PERIOD_H4;
   if(id == "D1"  || id == "1D")  return PERIOD_D1;
   return PERIOD_CURRENT;
  }

string TimeframeId(ENUM_TIMEFRAMES tf)
  {
   switch(tf)
     {
      case PERIOD_M1:  return "1m";
      case PERIOD_M5:  return "5m";
      case PERIOD_M15: return "15m";
      case PERIOD_H1:  return "1h";
      case PERIOD_H4:  return "4h";
      case PERIOD_D1:  return "1d";
      default:         return "1m";
     }
  }

//+------------------------------------------------------------------+
//| Minimal JSON extraction (our peer always sends compact JSON)     |
//+------------------------------------------------------------------+
string JsonGetString(string json, string key)
  {
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return "";
   int start = pos + StringLen(needle);
   int len = StringLen(json);
   while(start < len && StringGetCharacter(json, start) == ' ') start++;
   if(start >= len || StringGetCharacter(json, start) != '\"') return "";
   start++;
   string res = "";
   while(start < len)
     {
      ushort ch = StringGetCharacter(json, start);
      if(ch == '\\')
        {
         if(start + 1 < len)
           {
            ushort next = StringGetCharacter(json, start + 1);
            res += ShortToString((short)next);
            start += 2;
            continue;
           }
         break;
        }
      if(ch == '\"') break;
      res += ShortToString((short)ch);
      start++;
     }
   return res;
  }

double JsonGetNumber(string json, string key)
  {
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return 0.0;
   int start = pos + StringLen(needle);
   int len = StringLen(json);
   while(start < len && StringGetCharacter(json, start) == ' ') start++;
   string val = "";
   while(start < len)
     {
      ushort ch = StringGetCharacter(json, start);
      if(ch == ',' || ch == '}' || ch == ' ') break;
      val += ShortToString((short)ch);
      start++;
     }
   return StringToDouble(val);
  }

//+------------------------------------------------------------------+
//| WebSocket: key + handshake                                       |
//+------------------------------------------------------------------+
string GenerateWsKey()
  {
   uchar bytes[];
   ArrayResize(bytes, 16);
   for(int i = 0; i < 16; i++)
      bytes[i] = (uchar)(MathRand() & 0xFF);
   uchar key[];
   uchar enc[];
   if(CryptEncode(CRYPT_BASE64, bytes, key, enc) > 0 && ArraySize(enc) > 0)
      return CharArrayToString(enc, 0, ArraySize(enc));
   return "c2VydmVyLWtleS1mYWxsYmFjaw==";
  }

bool SendHandshake()
  {
   string key = GenerateWsKey();
   string request = StringFormat("GET / HTTP/1.1\r\n"
                                 "Host: %s:%d\r\n"
                                 "Upgrade: websocket\r\n"
                                 "Connection: Upgrade\r\n"
                                 "Sec-WebSocket-Key: %s\r\n"
                                 "Sec-WebSocket-Version: 13\r\n"
                                 "\r\n", InpHost, InpPort, key);
   uchar req[];
   int n = StringToCharArray(request, req, 0, WHOLE_ARRAY, CP_ACP);
   if(n > 0 && req[n - 1] == 0) n--;
   ArrayResize(req, n);
   if(SocketSend(g_socket, req, n) < 0)
     {
      WsDisconnect();
      return false;
     }
   return true;
  }

//+------------------------------------------------------------------+
//| WebSocket: send a masked text frame                              |
//+------------------------------------------------------------------+
bool WsSendFrame(int opcode, string text)
  {
   if(g_socket == INVALID_HANDLE) return false;

   uchar payload[];
   int n = StringToCharArray(text, payload, 0, StringLen(text), CP_UTF8);
   if(n <= 0) return false;
   if(n > 0 && payload[n - 1] == 0) n--;
   ArrayResize(payload, n);

   int headerLen = 2;
   if(n > 125) headerLen += (n > 65535) ? 8 : 2;
   headerLen += 4; // masking key

   uchar frame[];
   ArrayResize(frame, headerLen + n);
   frame[0] = (uchar)(0x80 | opcode);
   if(n <= 125)
      frame[1] = (uchar)(WS_MASK | n);
   else if(n <= 65535)
     {
      frame[1] = (uchar)(WS_MASK | 126);
      frame[2] = (uchar)((n >> 8) & 0xFF);
      frame[3] = (uchar)(n & 0xFF);
     }
   else
     {
      frame[1] = (uchar)(WS_MASK | 127);
      for(int i = 0; i < 8; i++)
         frame[2 + i] = (uchar)((((ulong)n) >> (8 * (7 - i))) & 0xFF);
     }

   int maskPos = 2 + ((n > 125) ? ((n > 65535) ? 8 : 2) : 0);
   for(int i = 0; i < 4; i++)
      frame[maskPos + i] = (uchar)(MathRand() & 0xFF);

   int payloadPos = maskPos + 4;
   for(int i = 0; i < n; i++)
      frame[payloadPos + i] = payload[i] ^ frame[maskPos + (i & 3)];

   int sentTotal = 0;
   int size = ArraySize(frame);
   while(sentTotal < size)
     {
      int sent = SocketSend(g_socket, frame, size - sentTotal);
      if(sent < 0)
        {
         WsDisconnect();
         return false;
        }
      sentTotal += sent;
      if(sentTotal < size)
        {
         int left = size - sentTotal;
         uchar tmp[];
         ArrayResize(tmp, left);
         ArrayCopy(tmp, frame, 0, sentTotal, left);
         ArrayResize(frame, left);
         ArrayCopy(frame, tmp, 0, 0, left);
         size = left;
         sentTotal = 0;
        }
     }
   return true;
  }

void SendText(string text)
  {
   if(g_state == WS_OPEN) WsSendFrame(WS_OP_TEXT, text);
  }

//+------------------------------------------------------------------+
//| WebSocket: frame parsing (handshake then RFC 6455 frames)        |
//+------------------------------------------------------------------+
// Returns true when a complete message was consumed (advances consumed).
bool WsDrainOne(uchar &buf[], int &consumed)
  {
   if(!g_handshakeDone)
      return WsHandleHandshake(buf, consumed);
   return WsHandleFrame(buf, consumed);
  }

bool WsHandleHandshake(uchar &buf[], int &consumed)
  {
   int size = ArraySize(buf);
   if(size < 4) return false;
   int end = -1;
   for(int i = 0; i <= size - 4; i++)
     {
      if(buf[i] == 13 && buf[i + 1] == 10 && buf[i + 2] == 13 && buf[i + 3] == 10)
        {
         end = i + 4;
         break;
        }
     }
   if(end < 0) return false;
   string header = CharArrayToString(buf, 0, end);
   consumed += end;
   g_handshakeDone = true;
   if(StringFind(header, " 101 ") >= 0 || StringFind(header, "101 Switching") >= 0)
     {
      g_state = WS_OPEN;
      WsOnOpen();
     }
   else
     {
      Print("EasyCandleBridge: handshake rejected");
      WsDisconnect();
     }
   return true;
  }

bool WsHandleFrame(uchar &buf[], int &consumed)
  {
   int size = ArraySize(buf) - consumed;
   if(size < 2) return false;
   int p = consumed;

   int b0 = buf[p];
   int opcode = b0 & 0x0F;
   int b1 = buf[p + 1];
   bool masked = (b1 & WS_MASK) != 0;
   int len7 = b1 & 0x7F;

   ulong payloadLen = (ulong)len7;
   int maskPos = p + 2;
   if(len7 == 126)
     {
      if(size < 4) return false;
      payloadLen = ((ulong)buf[p + 2] << 8) | (ulong)buf[p + 3];
      maskPos += 2;
     }
   else if(len7 == 127)
     {
      if(size < 10) return false;
      payloadLen = 0;
      for(int i = 0; i < 8; i++)
         payloadLen = (payloadLen << 8) | (ulong)buf[p + 2 + i];
      maskPos += 8;
     }

   if(payloadLen > MAX_RECV_TOTAL)
     {
      Print("EasyCandleBridge: frame too large, dropping connection");
      WsDisconnect();
      return true;
     }

   int headerEnd = maskPos + (masked ? 4 : 0);
   if(size < headerEnd + (int)payloadLen) return false;

   string payload = "";
   if(payloadLen > 0)
     {
      uchar tmp[];
      ArrayResize(tmp, (int)payloadLen);
      if(masked)
        {
         for(int i = 0; i < (int)payloadLen; i++)
            tmp[i] = buf[maskPos + 4 + i] ^ buf[maskPos + (i & 3)];
        }
      else
        {
         for(int i = 0; i < (int)payloadLen; i++)
            tmp[i] = buf[maskPos + i];
        }
      payload = CharArrayToString(tmp, 0, (int)payloadLen);
     }

   consumed += headerEnd + (int)payloadLen;

   if(opcode == WS_OP_PING)
     {
      WsSendFrame(WS_OP_PONG, "");
      return true;
     }
   if(opcode == WS_OP_PONG) return true;
   if(opcode == WS_OP_CLOSE)
     {
      WsDisconnect();
      return true;
     }
   if(opcode == WS_OP_TEXT || opcode == WS_OP_BINARY)
     {
      if(payload != "") WsHandleCommand(payload);
      return true;
     }
   return true; // skip continuation / unknown
  }

//+------------------------------------------------------------------+
//| Connection lifecycle                                             |
//+------------------------------------------------------------------+
void WsConnect()
  {
   if(g_socket != INVALID_HANDLE) return;
   g_socket = SocketCreate(SOCKET_DEFAULT);
   if(g_socket == INVALID_HANDLE)
     {
      Print("EasyCandleBridge: SocketCreate failed");
      return;
     }
   if(!SocketConnect(g_socket, InpHost, (uint)InpPort, 2000))
     {
      PrintFormat("EasyCandleBridge: SocketConnect %s:%d failed (err %d)", InpHost, InpPort, GetLastError());
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return;
     }
   g_state = WS_CONNECTING;
   g_handshakeDone = false;
   ArrayResize(g_recv, 0);
   SendHandshake();
   PrintFormat("EasyCandleBridge: TCP connected, handshake sent to %s:%d", InpHost, InpPort);
  }

void WsOnOpen()
  {
   PrintFormat("EasyCandleBridge connected to ws://%s:%d", InpHost, InpPort);
   g_lastPingAt = GetTickCount();
   SendHello();
   ResetBarTrackers();
   StreamBars();
  }

void WsDisconnect()
  {
   if(g_socket != INVALID_HANDLE)
     {
      WsSendFrame(WS_OP_CLOSE, "");
      SocketClose(g_socket);
     }
   g_socket = INVALID_HANDLE;
   g_state = WS_IDLE;
   g_handshakeDone = false;
   ArrayResize(g_recv, 0);
   ResetBarTrackers();
  }

void WsPoll()
  {
   if(g_socket == INVALID_HANDLE || g_state == WS_IDLE) return;
   if(!SocketIsConnected(g_socket))
     {
      Print("EasyCandleBridge: socket lost (SocketIsConnected == false)");
      WsDisconnect();
      return;
     }
   uint readable = (uint)SocketIsReadable(g_socket);
   if(readable == 0) return;

   // SocketRead waits until the full maxlen arrives, so always request exactly
   // the pending byte count — larger values stall until the timeout (-1).
   int maxlen = (int)readable;
   if(maxlen > MAX_RECV_CHUNK) maxlen = MAX_RECV_CHUNK;

   uchar chunk[];
   int got = SocketRead(g_socket, chunk, maxlen, 1000);
   if(got <= 0)
     {
      PrintFormat("EasyCandleBridge: SocketRead failed (%d, err %d)", got, GetLastError());
      WsDisconnect();
      return;
     }

   int cur = ArraySize(g_recv);
   ArrayResize(g_recv, cur + got);
   ArrayCopy(g_recv, chunk, cur, 0, got);
   if(ArraySize(g_recv) > MAX_RECV_TOTAL)
     {
      WsDisconnect();
      return;
     }

   int consumed = 0;
   while(consumed < ArraySize(g_recv))
     {
      if(!WsDrainOne(g_recv, consumed)) break;
     }

   int remaining = ArraySize(g_recv) - consumed;
   if(remaining > 0)
     {
      uchar tmp[];
      ArrayResize(tmp, remaining);
      ArrayCopy(tmp, g_recv, 0, consumed, remaining);
      ArrayResize(g_recv, remaining);
      ArrayCopy(g_recv, tmp, 0, 0, remaining);
     }
   else
      ArrayResize(g_recv, 0);
  }

//+------------------------------------------------------------------+
//| Outgoing messages                                                |
//+------------------------------------------------------------------+
void SendHello()
  {
   CAccountInfo account;
   string hello = StringFormat(
      "{\"type\":\"hello\",\"app\":\"easy-candle-ea\",\"version\":\"1.0.0\","
      "\"terminal\":\"MT5\",\"build\":\"%s\",\"account\":\"%s\",\"server\":\"%s\","
      "\"company\":\"%s\",\"symbol\":\"%s\",\"timeframe\":\"%s\",\"digits\":%d,"
      "\"isDemo\":%s}",
      (string)TerminalInfoInteger(TERMINAL_BUILD),
      IntegerToString(account.Login()),
      account.Server(),
      account.Company(),
      _Symbol,
      TimeframeId((ENUM_TIMEFRAMES)_Period),
      (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS),
      account.TradeMode() == ACCOUNT_TRADE_MODE_DEMO ? "true" : "false");
   SendText(hello);
  }

void SendTick()
  {
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   string msg = StringFormat(
      "{\"type\":\"tick\",\"symbol\":\"%s\",\"time\":%lld,\"bid\":%s,\"ask\":%s,"
      "\"last\":%s,\"volume\":%s}",
      _Symbol,
      (long)(tick.time_msc / 1000),
      DoubleToString(tick.bid, digits),
      DoubleToString(tick.ask, digits),
      DoubleToString(tick.last, digits),
      DoubleToString((double)tick.volume, 0));
   SendText(msg);
  }

bool CopyBar(string symbol, ENUM_TIMEFRAMES tf, int shift, MqlRates &out)
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(symbol, tf, shift, 1, rates) < 1) return false;
   out = rates[0];
   return true;
  }

void SendBar(string type, string symbol, ENUM_TIMEFRAMES tf, int shift)
  {
   MqlRates bar;
   if(!CopyBar(symbol, tf, shift, bar)) return;
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string msg = StringFormat(
      "{\"type\":\"bar\",\"symbol\":\"%s\",\"timeframe\":\"%s\",\"closed\":%s,"
      "\"bar\":{\"t\":%lld,\"o\":%s,\"h\":%s,\"l\":%s,\"c\":%s,\"v\":%s}}",
      symbol,
      TimeframeId(tf),
      (type == "closedBar" ? "true" : "false"),
      (long)bar.time,
      DoubleToString(bar.open, digits),
      DoubleToString(bar.high, digits),
      DoubleToString(bar.low, digits),
      DoubleToString(bar.close, digits),
      DoubleToString((double)bar.tick_volume, 0));
   SendText(msg);
  }

void SendError(string code, string message)
  {
   SendText(StringFormat("{\"type\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}", code, message));
  }

//+------------------------------------------------------------------+
//| Command dispatch (server -> EA)                                  |
//+------------------------------------------------------------------+
void WsHandleCommand(string json)
  {
   string type = JsonGetString(json, "type");
   if(type == "ping")
     {
      SendText("{\"type\":\"pong\"}");
      return;
     }
   if(type == "hello")
      return; // server identity — informational
   if(type == "setLive")
     {
      g_live = JsonGetNumber(json, "live") > 0.5;
      return;
     }
   if(type == "requestHistory")
      HandleHistoryRequest(json);
  }

void HandleHistoryRequest(string json)
  {
   string symbol = JsonGetString(json, "symbol");
   string tfId = JsonGetString(json, "timeframe");
   ENUM_TIMEFRAMES tf = TimeframeFromId(tfId);
   long from = (long)JsonGetNumber(json, "from");
   long to = (long)JsonGetNumber(json, "to");
   int limit = (int)JsonGetNumber(json, "limit");
   string requestId = JsonGetString(json, "requestId");

   if(limit <= 0) limit = 1000;
   if(limit > MAX_BARS_PER_RESPONSE) limit = MAX_BARS_PER_RESPONSE;
   if(symbol == "" || tf == PERIOD_CURRENT || from <= 0 || to <= from)
     {
      SendError("badRequest", "Invalid history request");
      return;
     }
   if(!SymbolSelect(symbol, true))
     {
      SendError("symbol", "Symbol not available in the terminal: " + symbol);
      return;
     }

   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(symbol, tf, (datetime)from, (datetime)to, rates);
   if(copied <= 0)
     {
      SendError("noData", StringFormat("No %s candles for %s in the requested range", tfId, symbol));
      return;
     }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   int periodSeconds = PeriodSeconds(tf);
   long now = (long)TimeCurrent();

   // rates[0] is the newest; iterate ascending and skip the forming bar.
   string arr = "[";
   int countOut = 0;
   for(int i = copied - 1; i >= 0 && countOut < limit; i--)
     {
      if((long)rates[i].time + periodSeconds > now) continue;
      if(countOut > 0) arr += ",";
      arr += StringFormat("{\"t\":%lld,\"o\":%s,\"h\":%s,\"l\":%s,\"c\":%s,\"v\":%s}",
                          (long)rates[i].time,
                          DoubleToString(rates[i].open, digits),
                          DoubleToString(rates[i].high, digits),
                          DoubleToString(rates[i].low, digits),
                          DoubleToString(rates[i].close, digits),
                          DoubleToString((double)rates[i].tick_volume, 0));
      countOut++;
     }
   arr += "]";

   if(countOut == 0)
     {
      SendError("noData", StringFormat("No completed %s candles for %s in the requested range", tfId, symbol));
      return;
     }

   string msg = StringFormat(
      "{\"type\":\"candles\",\"symbol\":\"%s\",\"timeframe\":\"%s\",\"from\":%lld,"
      "\"to\":%lld,\"requestId\":\"%s\",\"candles\":%s}",
      symbol, tfId, from, to, requestId, arr);
   SendText(msg);
  }

//+------------------------------------------------------------------+
//| Live streaming                                                   |
//+------------------------------------------------------------------+
void ParseTimeframes()
  {
   ArrayResize(g_subscribedTimeframes, 0);
   ArrayResize(g_lastBarOpen, 0);
   ArrayResize(g_lastBarSentAt, 0);

   string parts[];
   int n = StringSplit(InpTimeframes, ',', parts);
   for(int i = 0; i < n; i++)
     {
      string p = parts[i];
      StringTrimLeft(p);
      StringTrimRight(p);
      ENUM_TIMEFRAMES tf = TimeframeFromId(p);
      if(tf == PERIOD_CURRENT) continue;
      int idx = ArraySize(g_subscribedTimeframes);
      ArrayResize(g_subscribedTimeframes, idx + 1);
      ArrayResize(g_lastBarOpen, idx + 1);
      ArrayResize(g_lastBarSentAt, idx + 1);
      g_subscribedTimeframes[idx] = tf;
      g_lastBarOpen[idx] = 0;
      g_lastBarSentAt[idx] = 0;
     }
  }

void ResetBarTrackers()
  {
   for(int i = 0; i < ArraySize(g_lastBarOpen); i++)
      g_lastBarOpen[i] = 0;
  }

void StreamBars()
  {
   if(!g_live) return;
   int n = ArraySize(g_subscribedTimeframes);
   if(n == 0) return;

   for(int i = 0; i < n; i++)
     {
      ENUM_TIMEFRAMES tf = g_subscribedTimeframes[i];
      datetime barOpen = (datetime)iTime(_Symbol, tf, 0);
      if(barOpen == 0) continue;

      if(g_lastBarOpen[i] != barOpen)
        {
         if(g_lastBarOpen[i] != 0)
            SendBar("closedBar", _Symbol, tf, 1); // the bar that just closed
         g_lastBarOpen[i] = barOpen;
         SendBar("bar", _Symbol, tf, 0);
         g_lastBarSentAt[i] = GetTickCount();
        }
      else if((uint)(GetTickCount() - g_lastBarSentAt[i]) >= (uint)InpBarMs)
        {
         SendBar("bar", _Symbol, tf, 0);
         g_lastBarSentAt[i] = GetTickCount();
        }
     }
  }

//+------------------------------------------------------------------+
//| Event handlers                                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   MathSrand(GetTickCount() ^ (uint)TimeLocal());
   g_socket = INVALID_HANDLE;
   g_state = WS_IDLE;
   g_handshakeDone = false;
   g_live = InpEnable;
   g_lastTickSent = 0;
   ParseTimeframes();
   ArrayResize(g_recv, 0);
   EventSetMillisecondTimer(200);

   Comment("EasyCandleBridge: " + (InpEnable ? "enabled" : "disabled") +
           " · ws://" + InpHost + ":" + IntegerToString(InpPort));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason){
   EventKillTimer();
   WsDisconnect();
   Comment("");
   }

void OnTimer()
  {
   if(!InpEnable) return;

   if(g_state == WS_IDLE)
     {
      if((uint)(GetTickCount() - g_lastConnectAttempt) >= (uint)(InpReconnectSeconds * 1000))
        {
         g_lastConnectAttempt = GetTickCount();
         WsConnect();
        }
      return;
     }

   WsPoll();

   if(g_state == WS_OPEN)
     {
      StreamBars();
      if((uint)(GetTickCount() - g_lastPingAt) >= 30000)
        {
         g_lastPingAt = GetTickCount();
         SendText("{\"type\":\"pong\"}");
        }
     }
  }

void OnTick()
  {
   if(!InpEnable || !g_live) return;
   if(g_state != WS_OPEN) return;
   if((uint)(GetTickCount() - g_lastTickSent) < (uint)InpTickMs) return;
   g_lastTickSent = GetTickCount();
   SendTick();
  }
//+------------------------------------------------------------------+
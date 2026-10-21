require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const config = require('./config');
const CallHandler = require('./callHandler');
const { checkReturningPatient, getReturningPatientName } = require('./db');
const { maskPhone } = require('./redact');
// telephonyProbe has no imports of its own — safe to pull in here without
// risking the callHandler → crm → whatsapp cycle.
const { logPeer } = require('./telephonyProbe');
const {
  handleIncomingWhatsApp,
  verifyWebhook
} = require('./whatsapp');
const { initScheduler } = require('./scheduler');
const { gateAtUpgrade, gateAtStart, makeRejectionLogger } = require('./mediaStreamGate');
const logMediaStreamRejection = makeRejectionLogger();
const { initializeHeaders } = require('./sheets');

// ─── VALIDATE CONFIG AT STARTUP ───────────────────────────────────────────────
config.validate();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Hard ceiling on simultaneous live calls; the (N+1)th is rejected. Default 10
// (sized for free API tiers). Raise via env once Groq/Sarvam/Exotel paid tiers
// + PG_POOL_MAX are provisioned to match — e.g. ~25-30 for a 10-clinic fleet.
const MAX_CONCURRENT_CALLS = parseInt(process.env.MAX_CONCURRENT_CALLS, 10) || 10;
const VERSION = require('./package.json').version || '2.0.0';

// Normalize Indian phone numbers: 08273500806 → +918273500806
function normalizeIndianPhone(raw) {
  if (!raw || raw === 'Unknown') return 'Unknown';
  let digits = raw.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+91')) return digits;           // already international
  if (digits.startsWith('91') && digits.length >= 12) return '+' + digits;
  if (digits.startsWith('0')) digits = digits.substring(1); // strip leading 0
  if (digits.length === 10) return '+91' + digits;       // 10-digit mobile
  return raw; // unrecognized format — return as-is
}

// ─── EXPRESS APP ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: false }));
// The raw bytes are captured here because this is the ONLY place they still
// exist — express.json() parses and discards them, and Meta's signature is over
// the exact bytes it sent, which re-serialising req.body cannot reproduce
// (key order, unicode escaping, whitespace). See metaSignature.js.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { if (buf && buf.length) req.rawBody = buf; },
}));

// Browser-based test harness (mimics Exotel Voicebot applet protocol).
app.use('/test', express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

const server = http.createServer(app);
// noServer mode so we can gate upgrades on path.
const wss = new WebSocket.Server({ noServer: true });

// Active calls map
const activeCalls = new Map();

// ─── WHATSAPP WEBHOOK (Meta Cloud API) ────────────────────────────────────────
app.get('/whatsapp/incoming', verifyWebhook);
app.post('/whatsapp/incoming', handleIncomingWhatsApp);

// ─── EXOTEL PASSTHRU (optional — App Builder can GET this on call end) ───────
app.get('/exotel/call-end', (req, res) => {
  console.log('[EXOTEL] call-end passthru hit', req.query);
  res.sendStatus(200);
});

// ─── WEBSOCKET UPGRADE ROUTING ───────────────────────────────────────────────
server.on('upgrade', (request, socket, head) => {
  const { pathname, query } = url.parse(request.url, true);

  if (pathname === '/media-stream') {
    // Optional shared-secret gate (strong protection against arbitrary clients
    // connecting and injecting audio / burning STT+LLM quota). Enabled only when
    // MEDIA_STREAM_SECRET is set — then the Exotel Voicebot applet URL must carry
    // ?secret=<value>. Left off → no gate (account_sid check below still applies).
    // MEASURED 2026-09-13: Exotel sends the applet URL's ?secret= inside the
    // `start` message (custom_parameters), NOT on this upgrade — so a missing
    // secret here is deferred to the start handler; a wrong one is refused now.
    const verdict = gateAtUpgrade({ required: process.env.MEDIA_STREAM_SECRET, query });
    if (!verdict.ok) {
      // Says WHICH failure and from WHERE, once per 10s window, never the value.
      logMediaStreamRejection({
        ...verdict,
        where: 'upgrade',
        ip: request.socket && request.socket.remoteAddress,
        xff: request.headers['x-forwarded-for'],
        domain: process.env.RAILWAY_PUBLIC_DOMAIN
      });
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws._exotelQuery = query;
      ws._secretVerified = verdict.verified === true;
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── WEBSOCKET HANDLER (Exotel Voicebot applet) ──────────────────────────────
wss.on('connection', (ws, request) => {
  let callHandler = null;
  let audioChunkCount = 0;

  const query = ws._exotelQuery || {};
  console.log(`[EXOTEL] WebSocket connected — query=${JSON.stringify(query)}`);
  // Whose address dialled us — the one fact that decides Mumbai-vs-Singapore.
  logPeer(request);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.event) {
        case 'connected':
          console.log('[EXOTEL] event=connected');
          break;

        case 'start': {
          // Full start payload carries the raw caller phone — only dump it when
          // explicitly debugging Exotel field names (DEBUG_EXOTEL=true). The
          // masked Parsed line below is the normal log.
          if (process.env.DEBUG_EXOTEL === 'true') {
            console.log(`[EXOTEL] event=start FULL PAYLOAD: ${JSON.stringify(data.start)}`);
          }

          const start = data.start || {};

          // Anti-injection: drop connections that aren't from our Exotel account.
          // (Zero-config gate; for a hard gate set MEDIA_STREAM_SECRET — handled
          // at the upgrade above.)
          // Fail CLOSED: reject if account_sid is missing OR mismatched (Exotel
          // always sends it). Otherwise an attacker just omits the field to pass.
          if (config.exotel.sid && start.account_sid !== config.exotel.sid) {
            console.warn(`[EXOTEL] Rejected start: account_sid="${start.account_sid || '(missing)'}" != configured "${config.exotel.sid}"`);
            ws.close();
            return;
          }

          const customParams = start.customParameters || start.custom_parameters || {};

          // The shared-secret gate, decided here when the upgrade carried no
          // ?secret= (Exotel's normal case — see gateAtUpgrade). Closed before
          // any audio, STT or LLM spend.
          const secretVerdict = gateAtStart({ required: process.env.MEDIA_STREAM_SECRET, verifiedAtUpgrade: ws._secretVerified, customParams });
          if (!secretVerdict.ok) {
            logMediaStreamRejection({
              ...secretVerdict,
              where: 'start',
              ip: request.socket && request.socket.remoteAddress,
              xff: request.headers['x-forwarded-for'],
              domain: process.env.RAILWAY_PUBLIC_DOMAIN
            });
            ws.close();
            return;
          }

          const streamSid = start.streamSid || start.stream_sid || data.stream_sid || data.streamSid;

          // Exotel may deliver callSid as CallSid / call_sid / callSid.
          const callSid =
            customParams.callSid ||
            customParams.CallSid ||
            customParams.call_sid ||
            start.callSid ||
            start.call_sid ||
            streamSid ||
            'EXOTEL_' + Math.random().toString(36).substring(2, 10);

          const rawPhone =
            customParams.From ||
            customParams.from ||
            customParams.callerPhone ||
            customParams.caller_phone ||
            start.from ||
            start.From ||
            start.caller_id ||
            query.From ||
            query.caller_phone ||
            'Unknown';

          // Normalize Indian phone numbers to +91XXXXXXXXXX for WhatsApp compat.
          const callerPhone = normalizeIndianPhone(rawPhone);

          const callSource =
            customParams.To ||
            customParams.to ||
            customParams.callSource ||
            query.To ||
            config.exotel.phoneNumber ||
            'exotel';

          console.log(`[EXOTEL] Parsed → callSid=${callSid}, callerPhone=${maskPhone(callerPhone)}, streamSid=${streamSid}`);

          if (activeCalls.size >= MAX_CONCURRENT_CALLS) {
            console.warn(`[EXOTEL] Call rejected: concurrent limit reached (${activeCalls.size}/${MAX_CONCURRENT_CALLS})`);
            ws.close();
            return;
          }

          // Fetch the saved name (if any) so Ritu can greet a repeat patient
          // by name and skip the error-prone STT name capture. A non-null name
          // also implies returning.
          const returningName = await getReturningPatientName(callerPhone);
          const isReturning = returningName !== null || await checkReturningPatient(callerPhone);

          callHandler = new CallHandler(callSid, callerPhone, ws, callSource, isReturning, returningName);
          callHandler.streamSid = streamSid;
          activeCalls.set(callSid, callHandler);

          await callHandler.start();
          break;
        }

        case 'media':
          if (callHandler && data.media?.payload) {
            if (audioChunkCount < 3) {
              const sizeBytes = Buffer.from(data.media.payload, 'base64').length;
              console.log(`[EXOTEL] inbound audio chunk #${audioChunkCount + 1}: ${sizeBytes} bytes PCM16`);
              audioChunkCount++;
            }
            // Read the frame's OTHER fields before discarding them — that is
            // where a stream timestamp would live, and it has never been looked at.
            if (callHandler._telephony) { try { callHandler._telephony.onFrame(data.media); } catch (_) {} }
            callHandler.handleAudio(data.media.payload);
          }
          break;

        case 'mark':
          if (data.mark?.name === 'ritu_done' && callHandler) {
            if (callHandler._telephony) { try { callHandler._telephony.markEchoed('ritu_done'); } catch (_) {} }
            callHandler.onRituDone();
            console.log(`[EXOTEL ${callHandler.callSid}] Mark received: ritu_done — listening (echo blanking active)`);
          } else if (data.mark?.name === 'ritu_end_call' && callHandler) {
            console.log(`[EXOTEL ${callHandler.callSid}] Mark received: ritu_end_call — closing WebSocket`);
            await callHandler.endCall();
            activeCalls.delete(callHandler.callSid);
            callHandler = null;
          }
          break;

        case 'dtmf':
          console.log(`[EXOTEL] dtmf received: ${JSON.stringify(data.dtmf)}`);
          // Repair-ladder rung 3 (S2 T7): digits ride this same socket, so a
          // line that garbles speech still delivers clean DTMF. Consumed today
          // by the read-back confirm (1=yes, 2=no); no-op when nothing pends.
          if (callHandler && data.dtmf && data.dtmf.digit != null) {
            try { callHandler.onDtmf(String(data.dtmf.digit)); } catch (e) { console.error('[EXOTEL] dtmf handler error:', e.message); }
          }
          break;

        case 'stop':
          console.log('[EXOTEL] event=stop');
          if (callHandler) {
            callHandler._endTrigger = callHandler._endTrigger || 'exotel_stop';
            await callHandler.endCall();
            activeCalls.delete(callHandler.callSid);
            callHandler = null;
          }
          break;

        default:
          console.log(`[EXOTEL] unhandled event: ${data.event}`);
      }
    } catch (error) {
      console.error('[EXOTEL] WS message error:', error.message);
    }
  });

  ws.on('close', async () => {
    if (callHandler) {
      console.log(`[EXOTEL] WebSocket closed for call: ${callHandler.callSid}`);
      callHandler._endTrigger = callHandler._endTrigger || 'ws_close';
      await callHandler.endCall();
      activeCalls.delete(callHandler.callSid);
      callHandler = null;
    }
  });

  ws.on('error', (error) => {
    console.error('[EXOTEL] WS error:', error.message);
  });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    activeCalls: activeCalls.size,
    maxConcurrentCalls: MAX_CONCURRENT_CALLS,
    telephony: 'exotel',
    messaging: 'meta-cloud-api',
    scheduler: 'active'
  });
});

// ─── 404 HANDLER ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  server.close(() => {
    console.log('HTTP server closed.');
  });

  const endPromises = [];
  for (const [callSid, handler] of activeCalls) {
    console.log(`Ending call: ${callSid}`);
    handler._endTrigger = handler._endTrigger || 'shutdown';   // OUR redeploy, not the patient
    endPromises.push(handler.endCall().catch(err =>
      console.error(`Error ending call ${callSid}:`, err.message)
    ));
  }

  await Promise.allSettled(endPromises);
  activeCalls.clear();

  console.log('All calls ended. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
(async () => {
  await initializeHeaders();
  initScheduler();
  // Once at boot: does Meta deliver this clinic's WhatsApp replies HERE? (gated
  // by TOKEN_HEALTH_CHECK=on inside; read-only; the daily cron repeats it.)
  setTimeout(() => { require('./scheduler').runWebhookRouteCheck(); }, 10000).unref();
  require('./llm').startHealthProbe(); // re-check capped LLM providers off the call path
  // Lean mode (small clinic / demo): preload the doctor roster into memory so the
  // single-call brain has it grounded in the prompt (no find_doctor tool).
  // UNCONDITIONAL since 2026-08-01. This used to sit inside the lean-mode `if`,
  // and config.clinicMode defaults to 'full' — so on any deployment that does not
  // set CLINIC_MODE, the roster stayed empty. On voice that was masked (the
  // tool-calling path looks doctors up itself). On the WhatsApp path, which now
  // shares brain-lean, an empty roster makes resolveDoctor() fail for EVERY
  // booking, and brain-lean answers with the `unknownDoctor` canned line — a
  // 100% silent booking failure with no error and no log line to find it by.
  // The roster is a cheap in-memory read; loading it in both modes costs nothing
  // and removes a failure mode that would have been very hard to diagnose live.
  await require('./brain-lean').preloadRoster(config.clinicId);
  // ANNOUNCE THE MODE IN BOTH CASES. Until now only lean printed a line, so a
  // deployment that forgot CLINIC_MODE booted clean, greeted normally, and
  // booked — into Google Calendar ONLY. brain.js's booking path calls
  // calendar.bookAppointment; the appointments INSERT lives exclusively in
  // tools/bookAppointment.js, which only the lean path reaches. No row means no
  // 24-hour reminder, nothing on the desk day-sheet, and no record the clinic
  // can audit — while the onboarding smoke test still passes, because a CALL
  // record is written either way. Silence was the whole bug.
  if (config.clinicMode !== 'lean') {
    console.warn(`⚠ CLINIC_MODE=${config.clinicMode} (not "lean") — bookings go to Google Calendar and write NO appointments row: no reminder, nothing on the desk. Set CLINIC_MODE=lean unless you specifically want the legacy tool-calling brain.`);
  }
  if (config.clinicMode === 'lean') {
    console.log('✓ Lean mode ON (preloaded roster, single-call path — no tool-calling)');
  }

  // ─── IS THIS DEPLOY STILL WEARING THE FIRST CLINIC'S CLOTHES? ─────────────
  // Every one of these has a default that belongs to the demo clinic, and a
  // deploy that forgets one looks completely healthy: it boots, greets, books,
  // and quietly says or writes the wrong clinic's name. That is not something a
  // smoke test catches, because nothing is broken — it is just somebody else's.
  //
  // Printed together, once, so onboarding has one line to check rather than a
  // doc to trust. CLINIC_ONBOARDING.md had CLINIC_GREETING_NAME spelled
  // backwards for its whole life; a doc cannot verify itself.
  const inherited = [];
  if (!process.env.CLINIC_GREETING_NAME) inherited.push('CLINIC_GREETING_NAME (spoken greeting)');
  if (!process.env.CLINIC_NAME) inherited.push('CLINIC_NAME (tool-brain + off-topic line)');
  if (!process.env.CLINIC_ADDRESS) inherited.push('CLINIC_ADDRESS (Ritu says she does not have it)');
  if (inherited.length) {
    console.warn(`⚠ USING DEFAULTS FOR: ${inherited.join(', ')} — this clinic will speak the default clinic's identity. Set them unless this IS that clinic.`);
  }
  console.log(`[CONFIG] clinic: id=${config.clinicId || 'UNSET'} greeting="${config.greetingClinicName}" sheets=${process.env.GOOGLE_SHEET_ID ? 'own sheet' : 'off'}`);
  console.log('✓ WhatsApp automation active (Meta Cloud API)');
  console.log('✓ Scheduler running');

  server.listen(config.port, () => {
    console.log(`\n═══════════════════════════════════════`);
    console.log(`  Engageo Server v${VERSION} (Exotel + Meta)`);
    console.log(`  Port: ${config.port}`);
    console.log(`  Max concurrent calls: ${MAX_CONCURRENT_CALLS}`);
    console.log(`  Voice WS:   wss://<host>/media-stream?sample-rate=8000`);
    console.log(`  WhatsApp:   GET/POST /whatsapp/incoming`);
    console.log(`  Health:     GET /health`);
    console.log(`═══════════════════════════════════════\n`);
    // Tell the desk what this service is running with (slot length, may Ritu
    // cancel, which jobs are on). Fire-and-forget: it never blocks or fails boot.
    require('./db').reportRuntime().catch((err) => console.warn('[RUNTIME] report threw:', err.message));
  });
})();

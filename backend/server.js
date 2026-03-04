// backend/server.js — Stillwater VR Token Proxy

// Gracefully load .env for local dev — skip silently on Render
import { config as dotenvConfig } from 'dotenv';
try { dotenvConfig(); } catch (_) { /* no .env file — using injected env vars */ }

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = 3000;

// ── CORS ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Startup Environment Check ─────────────────────────────
console.log('\n[ENV CHECK] Verifying environment variables…');
const requiredVars = [
    'AZURE_SPEECH_KEY',
    'AZURE_SPEECH_REGION',
    'AZURE_OPENAI_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_DEPLOYMENT',
];
let envOk = true;
for (const v of requiredVars) {
    if (process.env[v]) {
        console.log(`[ENV CHECK] ✓ ${v} = set (${process.env[v].substring(0, 4)}…)`);
    } else {
        console.error(`[ENV CHECK] ✗ ${v} = MISSING`);
        envOk = false;
    }
}
console.log(envOk ? '[ENV CHECK] ✓ All variables present.\n' : '[ENV CHECK] ✗ Some variables are MISSING — endpoints will fail.\n');

// ── POST /api/get-speech-token ────────────────────────
// Exchanges the subscription key for a short-lived JWT
app.post('/api/get-speech-token', async (req, res) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;

    if (!speechKey || !speechRegion) {
        const missing = [];
        if (!speechKey) missing.push('AZURE_SPEECH_KEY');
        if (!speechRegion) missing.push('AZURE_SPEECH_REGION');
        console.error(`[Token Status] ✗ MISSING env vars: ${missing.join(', ')}`);
        return res.status(500).json({ error: `Server misconfiguration: missing ${missing.join(', ')}` });
    }

    try {
        console.log('[Token Status] Requesting authorization token…');
        const tokenResponse = await fetch(
            `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
            {
                method: 'POST',
                headers: {
                    'Ocp-Apim-Subscription-Key': speechKey,
                    'Ocp-Apim-Subscription-Region': speechRegion,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: '', // empty body required
            }
        );

        if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            console.error(`[Token Status] ✗ Azure returned ${tokenResponse.status}: ${errorText}`);
            return res.status(tokenResponse.status).json({ error: errorText });
        }

        const token = await tokenResponse.text();
        console.log('[Token Status] ✓ Token acquired (length: ' + token.length + ')');
        return res.json({ token, region: speechRegion });
    } catch (err) {
        console.error('[Token Status] ✗ Network error:', err.message);
        return res.status(500).json({ error: 'Failed to acquire speech token.' });
    }
});

// ── GET /api/get-ice-token ────────────────────────────
// Fetches ICE relay credentials for WebRTC avatar streaming
app.get('/api/get-ice-token', async (req, res) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;

    if (!speechKey || !speechRegion) {
        const missing = [];
        if (!speechKey) missing.push('AZURE_SPEECH_KEY');
        if (!speechRegion) missing.push('AZURE_SPEECH_REGION');
        console.error(`[WebSocket Status] ✗ MISSING env vars: ${missing.join(', ')}`);
        return res.status(500).json({ error: `Server misconfiguration: missing ${missing.join(', ')}` });
    }

    try {
        console.log('[WebSocket Status] Requesting ICE relay token…');
        const iceResponse = await fetch(
            `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1`,
            {
                method: 'GET',
                headers: {
                    'Ocp-Apim-Subscription-Key': speechKey,
                },
            }
        );

        if (!iceResponse.ok) {
            const errorText = await iceResponse.text();
            console.error(`[WebSocket Status] ✗ ICE token error ${iceResponse.status}: ${errorText}`);
            return res.status(iceResponse.status).json({ error: errorText });
        }

        const iceData = await iceResponse.json();
        console.log('[WebSocket Status] ✓ ICE relay credentials received');
        return res.json(iceData);
    } catch (err) {
        console.error('[WebSocket Status] ✗ Network error:', err.message);
        return res.status(500).json({ error: 'Failed to acquire ICE token.' });
    }
});

// ── POST /api/chat ────────────────────────────────────
// Proxies chat requests to Azure OpenAI (Kimi-K2.5) with streaming
app.post('/api/chat', async (req, res) => {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!endpoint || !apiKey || !deployment) {
        const missing = [];
        if (!endpoint) missing.push('AZURE_OPENAI_ENDPOINT');
        if (!apiKey) missing.push('AZURE_OPENAI_KEY');
        if (!deployment) missing.push('AZURE_OPENAI_DEPLOYMENT');
        console.error(`[Kimi Handshake] ✗ MISSING env vars: ${missing.join(', ')}`);
        return res.status(500).json({ error: `Server misconfiguration: missing ${missing.join(', ')}` });
    }

    try {
        const { messages } = req.body;
        const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-05-01-preview`;

        console.log('[Kimi Handshake] Sending chat request to Kimi-K2.5…');
        const chatResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages,
                stream: true,
            }),
        });

        if (!chatResponse.ok) {
            const errorText = await chatResponse.text();
            console.error(`[Kimi Handshake] ✗ Azure OpenAI returned ${chatResponse.status}: ${errorText}`);
            return res.status(chatResponse.status).send(errorText);
        }

        console.log('[Kimi Handshake] ✓ Streaming response from Kimi-K2.5');

        // Stream the SSE response directly to the client
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        chatResponse.body.pipe(res);
    } catch (err) {
        console.error('[Kimi Handshake] ✗ Error:', err.message);
        return res.status(500).json({ error: 'Chat request failed.' });
    }
});

// ── Start Server ──────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║   Stillwater VR — Backend Active             ║`);
    console.log(`║   Token Proxy:  http://localhost:${PORT}         ║`);
    console.log(`║   Endpoints:                                 ║`);
    console.log(`║     POST /api/get-speech-token               ║`);
    console.log(`║     GET  /api/get-ice-token                  ║`);
    console.log(`║     POST /api/chat                           ║`);
    console.log(`╚══════════════════════════════════════════════╝\n`);
    console.log('Credentials detected:');
    console.log('  Azure Speech Key:', !!process.env.AZURE_SPEECH_KEY);
    console.log('  Azure Speech Region:', !!process.env.AZURE_SPEECH_REGION);
    console.log('  Azure OpenAI Key:', !!process.env.AZURE_OPENAI_KEY);
    console.log('  Azure OpenAI Endpoint:', !!process.env.AZURE_OPENAI_ENDPOINT);
    console.log('  Azure OpenAI Deployment:', !!process.env.AZURE_OPENAI_DEPLOYMENT);
});

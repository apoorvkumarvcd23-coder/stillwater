// ═══════════════════════════════════════════════════════
//  Stillwater VR — AI Orchestration Layer (main.js)
//  Speech SDK (AvatarSynthesizer) + WebRTC + Kimi-K2.5
// ═══════════════════════════════════════════════════════

// ── Backend URL (swap with production URL once deployed) ─
const BACKEND_URL = 'http://172.20.10.4:3000';

const SpeechSDK = window.SpeechSDK;

// ── State ──────────────────────────────────────────────
let avatarSynthesizer = null;
let speechRecognizer = null;
let peerConnection = null;
let isSpeaking = false;
let isListening = false;
let spokenTextQueue = [];
let speakingText = '';
let sessionActive = false;
let messages = [];

const SENTENCE_PUNCTUATIONS = ['.', '?', '!', ':', ';', '。', '？', '！', '：', '；'];
const AVATAR_CHARACTER = 'lisa';
const AVATAR_STYLE = 'casual-sitting';
const TTS_VOICE = 'en-US-JennyNeural';

// ── DOM References ─────────────────────────────────────
const $ = (id) => document.getElementById(id);
const loadingOverlay = $('loading-overlay');
const loadingStatus = $('loading-status');
const avatarVideoLeft = $('avatar-video-left');
const avatarVideoRight = $('avatar-video-right');
const micBtnLeft = $('mic-btn-left');
const micBtnRight = $('mic-btn-right');
const statusDotLeft = $('status-dot-left');
const statusDotRight = $('status-dot-right');
const statusTextLeft = $('status-text-left');
const statusTextRight = $('status-text-right');
const transcriptLeft = $('transcript-left');
const transcriptRight = $('transcript-right');
const subtitleLeft = $('subtitle-left');
const subtitleRight = $('subtitle-right');

// ── Background Audio Config ───────────────────────────
const BG_VOLUME_FULL = 0.5;       // normal playback volume
const BG_VOLUME_DUCKED = 0.08;    // volume while mic is active
const BG_FADE_DURATION = 400;     // ms for fade transition
let bgAudioUnmuted = false;

function setBgVolume(targetVol) {
    const videos = [cinemaBgLeft, cinemaBgRight];
    const steps = 20;
    const interval = BG_FADE_DURATION / steps;

    videos.forEach((vid) => {
        const startVol = vid.volume;
        const delta = (targetVol - startVol) / steps;
        let step = 0;

        const fade = setInterval(() => {
            step++;
            vid.volume = Math.max(0, Math.min(1, startVol + delta * step));
            if (step >= steps) clearInterval(fade);
        }, interval);
    });
}

function unmuteBgVideos() {
    if (bgAudioUnmuted) return;
    bgAudioUnmuted = true;
    cinemaBgLeft.muted = false;
    cinemaBgRight.muted = false;
    cinemaBgLeft.volume = BG_VOLUME_FULL;
    cinemaBgRight.volume = BG_VOLUME_FULL;
    console.log('[Background] ✓ Audio unmuted');
}

// ── Utility Functions ──────────────────────────────────
function setStatus(text, type = 'default') {
    statusTextLeft.textContent = text;
    statusTextRight.textContent = text;

    statusDotLeft.className = 'status-dot';
    statusDotRight.className = 'status-dot';
    if (type === 'connected') {
        statusDotLeft.classList.add('connected');
        statusDotRight.classList.add('connected');
    } else if (type === 'error') {
        statusDotLeft.classList.add('error');
        statusDotRight.classList.add('error');
    }
}

function setTranscript(text) {
    transcriptLeft.textContent = text;
    transcriptRight.textContent = text;
    if (text) {
        transcriptLeft.classList.add('visible');
        transcriptRight.classList.add('visible');
    } else {
        transcriptLeft.classList.remove('visible');
        transcriptRight.classList.remove('visible');
    }
}

function setSubtitle(text) {
    subtitleLeft.textContent = text;
    subtitleRight.textContent = text;
    if (text) {
        subtitleLeft.classList.add('visible');
        subtitleRight.classList.add('visible');
    } else {
        subtitleLeft.classList.remove('visible');
        subtitleRight.classList.remove('visible');
    }
}

function setLoading(text) {
    loadingStatus.textContent = text;
}

function hideLoading() {
    loadingOverlay.classList.add('hidden');
    setTimeout(() => { loadingOverlay.style.display = 'none'; }, 800);
}

function htmlEncode(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── 1. Token Acquisition ───────────────────────────────
async function fetchSpeechToken() {
    try {
        console.log('[Token Status] Requesting speech authorization token…');
        setLoading('Acquiring neural token…');

        const response = await fetch(`${BACKEND_URL}/api/get-speech-token`, { method: 'POST' });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(`HTTP ${response.status}: ${err.error || 'Unknown error'}`);
        }

        const data = await response.json();
        console.log('[Token Status] ✓ Token acquired (length: ' + data.token.length + ')');
        return data;
    } catch (err) {
        console.error('[Token Status] ✗ Failed to acquire token:', err.message);
        setStatus('Token Error', 'error');
        throw err;
    }
}

async function fetchIceToken() {
    try {
        console.log('[WebSocket Status] Requesting ICE relay token…');
        setLoading('Establishing relay channel…');

        const response = await fetch(`${BACKEND_URL}/api/get-ice-token`);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(`HTTP ${response.status}: ${err.error || 'Unknown error'}`);
        }

        const data = await response.json();
        console.log('[WebSocket Status] ✓ ICE credentials received');
        return data;
    } catch (err) {
        console.error('[WebSocket Status] ✗ Failed to acquire ICE token:', err.message);
        setStatus('Relay Error', 'error');
        throw err;
    }
}

// ── 2. Avatar Startup ──────────────────────────────────
async function initializeAvatar(authToken, region, iceData) {
    try {
        setLoading('Configuring avatar synthesizer…');

        // Speech config from auth token
        const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(authToken, region);

        // Avatar config
        const avatarConfig = new SpeechSDK.AvatarConfig(AVATAR_CHARACTER, AVATAR_STYLE);

        // Create avatar synthesizer
        avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechConfig, avatarConfig);
        avatarSynthesizer.avatarEventReceived = (s, e) => {
            const offsetMsg = e.offset === 0 ? '' : `, offset: ${e.offset / 10000}ms`;
            console.log(`[Avatar Event] ${e.description}${offsetMsg}`);
        };

        console.log('[WebSocket Status] AvatarSynthesizer created. Setting up WebRTC…');
        setLoading('Establishing WebRTC connection…');

        // Setup WebRTC peer connection with ICE credentials
        await setupWebRTC(iceData);
    } catch (err) {
        console.error('[WebSocket Status] ✗ Avatar initialization failed:', err.message);
        setStatus('Avatar Error', 'error');
        throw err;
    }
}

async function setupWebRTC(iceData) {
    // Create RTCPeerConnection with Azure's ICE servers
    peerConnection = new RTCPeerConnection({
        iceServers: [{
            urls: [iceData.Urls[0]],
            username: iceData.Username,
            credential: iceData.Password,
        }],
    });

    // Handle incoming tracks (audio + video from avatar)
    peerConnection.ontrack = (event) => {
        if (event.track.kind === 'audio') {
            console.log('[WebSocket Status] Audio track received');
            const audioEl = document.createElement('audio');
            audioEl.id = 'avatar-audio';
            audioEl.srcObject = event.streams[0];
            audioEl.autoplay = true;

            audioEl.addEventListener('loadeddata', () => {
                audioEl.play().then(() => {
                    console.log('[WebSocket Status] ✓ Avatar audio playing');
                }).catch((err) => {
                    console.warn('[WebSocket Status] Audio autoplay blocked, will retry on user gesture:', err.message);
                });
            });

            // Remove old audio
            const container = $('remoteAudio');
            container.innerHTML = '';
            container.appendChild(audioEl);

            // Store reference globally for user gesture retry
            window._avatarAudioEl = audioEl;
        }

        if (event.track.kind === 'video') {
            console.log('[WebSocket Status] Video track received');

            const stream = event.streams[0];

            // ── STEREO BINDING: Mirror to BOTH eyes ──
            avatarVideoLeft.srcObject = stream;
            avatarVideoRight.srcObject = stream;

            avatarVideoLeft.play().catch(() => { });
            avatarVideoRight.play().catch(() => { });

            avatarVideoLeft.onplaying = () => {
                console.log('[WebSocket Status] ✓ Video playing on LEFT eye');
            };
            avatarVideoRight.onplaying = () => {
                console.log('[WebSocket Status] ✓ Video playing on RIGHT eye');
                setStatus('Guide Connected', 'connected');
                sessionActive = true;
                hideLoading();
            };
        }
    };

    // Data channel for avatar events
    peerConnection.addEventListener('datachannel', (event) => {
        const dataChannel = event.channel;
        dataChannel.onmessage = (e) => {
            try {
                const webRTCEvent = JSON.parse(e.data);
                console.log('[WebSocket Status] WebRTC event:', webRTCEvent.event.eventType);

                if (webRTCEvent.event.eventType === 'EVENT_TYPE_TURN_START') {
                    setSubtitle(speakingText);
                } else if (
                    webRTCEvent.event.eventType === 'EVENT_TYPE_SESSION_END' ||
                    webRTCEvent.event.eventType === 'EVENT_TYPE_SWITCH_TO_IDLE'
                ) {
                    setSubtitle('');
                }
            } catch (err) {
                // ignore non-JSON events
            }
        };
    });

    // Workaround: create client-side data channel
    peerConnection.createDataChannel('eventChannel');

    // ICE connection state logging
    peerConnection.oniceconnectionstatechange = () => {
        console.log('[WebSocket Status] ICE state:', peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed') {
            setStatus('Connection Lost', 'error');
            sessionActive = false;
        }
    };

    // Add transceivers for audio + video
    peerConnection.addTransceiver('video', { direction: 'sendrecv' });
    peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

    // Start avatar session
    console.log('[WebSocket Status] Starting avatar via startAvatarAsync…');
    setLoading('Summoning the Guide…');

    const result = await avatarSynthesizer.startAvatarAsync(peerConnection);

    if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
        console.log(`[WebSocket Status] ✓ Avatar started. Result ID: ${result.resultId}`);
    } else {
        console.error(`[WebSocket Status] ✗ Avatar failed to start. Result ID: ${result.resultId}`);
        if (result.reason === SpeechSDK.ResultReason.Canceled) {
            const details = SpeechSDK.CancellationDetails.fromResult(result);
            console.error('[WebSocket Status] Cancellation details:', details.errorDetails);
            throw new Error(details.errorDetails);
        }
    }
}

// ── 3. Speech Recognition (Continuous) ─────────────────
async function initializeSpeechRecognition(authToken, region) {
    try {
        const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(authToken, region);
        speechConfig.speechRecognitionLanguage = 'en-US';

        const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
        speechRecognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

        // Recognized event (final result)
        speechRecognizer.recognized = (s, e) => {
            if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech && e.result.text.trim()) {
                const userText = e.result.text.trim();
                console.log(`[STT] Recognized: "${userText}"`);
                setTranscript(userText);

                // Send to Kimi-K2.5 brain
                handleUserQuery(userText);

                // Clear transcript after 3s
                setTimeout(() => setTranscript(''), 3000);
            }
        };

        // Recognizing event (interim results)
        speechRecognizer.recognizing = (s, e) => {
            if (e.result.text.trim()) {
                setTranscript(e.result.text.trim() + '…');
            }
        };

        speechRecognizer.canceled = (s, e) => {
            console.warn('[STT] Recognition canceled:', e.errorDetails || e.reason);
        };

        speechRecognizer.sessionStopped = () => {
            console.log('[STT] Session stopped');
        };

        console.log('[STT] ✓ Speech recognizer configured');
    } catch (err) {
        console.error('[STT] ✗ Failed to initialize speech recognition:', err.message);
        throw err;
    }
}

function startListening() {
    if (!speechRecognizer) return;

    speechRecognizer.startContinuousRecognitionAsync(
        () => {
            isListening = true;
            console.log('[STT] ✓ Continuous recognition started');
            setStatus('Listening…', 'connected');
            micBtnLeft.classList.add('listening');
            micBtnRight.classList.add('listening');
            setBgVolume(BG_VOLUME_DUCKED);
        },
        (err) => {
            console.error('[STT] ✗ Failed to start recognition:', err);
            setStatus('Mic Error', 'error');
        }
    );
}

function stopListening() {
    if (!speechRecognizer) return;

    speechRecognizer.stopContinuousRecognitionAsync(
        () => {
            isListening = false;
            console.log('[STT] Recognition stopped');
            setStatus('Guide Connected', 'connected');
            micBtnLeft.classList.remove('listening');
            micBtnRight.classList.remove('listening');
            setTranscript('');
            setBgVolume(BG_VOLUME_FULL);
        },
        (err) => {
            console.error('[STT] ✗ Failed to stop recognition:', err);
        }
    );
}

function toggleListening() {
    // Resume avatar audio on first user gesture (browser autoplay policy)
    if (window._avatarAudioEl && window._avatarAudioEl.paused) {
        window._avatarAudioEl.play().then(() => {
            console.log('[WebSocket Status] ✓ Avatar audio resumed via user gesture');
        }).catch(() => { });
    }

    // Unmute background video audio on first gesture
    unmuteBgVideos();

    if (isListening) {
        stopListening();
    } else {
        startListening();
    }
}

// ── 4. Kimi-K2.5 Brain (Chat) ──────────────────────────
function initMessages() {
    messages = [
        {
            role: 'system',
            content: `You are the Stillwater Guide, a calm, wise AI assistant. You speak with clarity and grace, offering thoughtful insights. Keep your responses concise — no more than 3 sentences unless the user requests more detail. You are embodied as a virtual avatar in a VR environment.`,
        },
    ];
}

async function handleUserQuery(userText) {
    try {
        messages.push({ role: 'user', content: userText });

        console.log('[Kimi Handshake] Sending query to Kimi-K2.5…');

        const response = await fetch(`${BACKEND_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages }),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[Kimi Handshake] ✗ HTTP ${response.status}: ${errText}`);
            return;
        }

        console.log('[Kimi Handshake] ✓ Streaming response received');

        const reader = response.body.getReader();
        let assistantReply = '';
        let spokenSentence = '';

        async function readStream() {
            let partialChunk = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                const chunkStr = partialChunk + new TextDecoder().decode(value, { stream: true });
                partialChunk = '';

                const lines = chunkStr.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();

                    // If this is the last element and doesn't end cleanly, save for next iteration
                    if (i === lines.length - 1 && !line.endsWith('}') && line !== '' && !line.endsWith('[DONE]')) {
                        partialChunk = lines[i];
                        continue;
                    }

                    if (line.startsWith('data:') && !line.endsWith('[DONE]')) {
                        try {
                            const json = JSON.parse(line.substring(5).trim());
                            const token = json.choices?.[0]?.delta?.content;

                            if (token !== undefined && token !== null) {
                                assistantReply += token;
                                spokenSentence += token;

                                // Check for sentence-ending punctuation
                                if (token === '\n' || token === '\n\n') {
                                    if (spokenSentence.trim()) {
                                        speak(spokenSentence.trim());
                                    }
                                    spokenSentence = '';
                                } else {
                                    const cleanToken = token.replace(/\n/g, '');
                                    if (cleanToken.length <= 2) {
                                        for (const punct of SENTENCE_PUNCTUATIONS) {
                                            if (cleanToken.includes(punct)) {
                                                if (spokenSentence.trim()) {
                                                    speak(spokenSentence.trim());
                                                }
                                                spokenSentence = '';
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (parseErr) {
                            // skip malformed chunks
                        }
                    }
                }
            }

            // Speak any remaining text
            if (spokenSentence.trim()) {
                speak(spokenSentence.trim());
            }

            // Store assistant reply
            messages.push({ role: 'assistant', content: assistantReply });
            console.log(`[Kimi Handshake] ✓ Full response: "${assistantReply.substring(0, 80)}…"`);
        }

        await readStream();
    } catch (err) {
        console.error('[Kimi Handshake] ✗ Error:', err.message);
    }
}

// ── 5. Avatar Speech (TTS) ─────────────────────────────
function speak(text, endingSilenceMs = 0) {
    if (isSpeaking) {
        spokenTextQueue.push(text);
        return;
    }
    speakNext(text, endingSilenceMs);
}

function speakNext(text, endingSilenceMs = 0) {
    if (!avatarSynthesizer) {
        console.warn('[TTS] Avatar synthesizer not ready');
        return;
    }

    let ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'>
    <voice name='${TTS_VOICE}'>
      <mstts:leadingsilence-exact value='0'/>${htmlEncode(text)}${endingSilenceMs > 0 ? `<break time='${endingSilenceMs}ms' />` : ''
        }
    </voice>
  </speak>`;

    isSpeaking = true;
    speakingText = text;
    setSubtitle(text);

    avatarSynthesizer.speakSsmlAsync(ssml).then(
        (result) => {
            if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
                console.log(`[TTS] ✓ Spoke: "${text.substring(0, 50)}…"`);
            } else {
                console.error(`[TTS] ✗ Synthesis error for: "${text.substring(0, 50)}…"`);
            }

            speakingText = '';
            setSubtitle('');

            if (spokenTextQueue.length > 0) {
                speakNext(spokenTextQueue.shift());
            } else {
                isSpeaking = false;
            }
        },
        (error) => {
            console.error(`[TTS] ✗ Error: ${error}`);
            speakingText = '';
            setSubtitle('');

            if (spokenTextQueue.length > 0) {
                speakNext(spokenTextQueue.shift());
            } else {
                isSpeaking = false;
            }
        }
    );
}

// ── 6. Boot Sequence ───────────────────────────────────
async function boot() {
    try {
        console.log('═══════════════════════════════════════');
        console.log('  Stillwater VR — Boot Sequence');
        console.log('═══════════════════════════════════════');

        // Initialize message history
        initMessages();

        // Step 1: Fetch speech token
        const { token: authToken, region } = await fetchSpeechToken();

        // Step 2: Fetch ICE relay credentials
        const iceData = await fetchIceToken();

        // Step 3: Initialize avatar (WebRTC + AvatarSynthesizer)
        await initializeAvatar(authToken, region, iceData);

        // Step 4: Initialize speech recognition
        await initializeSpeechRecognition(authToken, region);

        console.log('[Boot] ✓ All systems nominal. Guide is ready.');
    } catch (err) {
        console.error('[Boot] ✗ Boot sequence failed:', err.message);
        setLoading('Connection failed. Please refresh.');
        setStatus('Boot Failed', 'error');
    }
}

// ── Event Listeners ────────────────────────────────────
micBtnLeft.addEventListener('click', toggleListening);
micBtnRight.addEventListener('click', toggleListening);

// ── Background Video File Picker ───────────────────────
const bgPickerBtn = $('bg-picker-btn');
const bgVideoInput = $('bg-video-input');
const cinemaBgLeft = $('cinema-bg-left');
const cinemaBgRight = $('cinema-bg-right');

bgPickerBtn.addEventListener('click', () => {
    bgVideoInput.click();
});

bgVideoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('video/')) {
        const objectURL = URL.createObjectURL(file);

        // Load into BOTH eye panels for proper SBS stereo
        cinemaBgLeft.src = objectURL;
        cinemaBgRight.src = objectURL;

        cinemaBgLeft.play().catch(() => { });
        cinemaBgRight.play().catch(() => { });

        // Keep both eyes in sync
        cinemaBgLeft.addEventListener('seeked', () => {
            cinemaBgRight.currentTime = cinemaBgLeft.currentTime;
        });

        console.log(`[Background] ✓ Loaded local video into both eyes: ${file.name}`);
    }
});

// ── Launch ─────────────────────────────────────────────
boot();

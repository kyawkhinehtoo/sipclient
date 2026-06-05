import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  SessionState,
  SIPExtension,
  UserAgent,
  Web,
} from 'sip.js';
import { formatCallEndStatus } from './callStatusText.js';
import callTonePlayer from './callTonePlayer.js';

/** Retry delays while 183/180 SDP negotiates ICE and ontrack fires. */
const EARLY_MEDIA_PLAYBACK_DELAYS_MS = [0, 100, 250, 500, 1000, 2000];

/** Hold call UI after reject so operator announcement or local busy tone can play. */
const REJECT_TEARDOWN_DELAY_MS = 3500;

const defaultSessionDescriptionHandlerFactory = Web.defaultSessionDescriptionHandlerFactory();
const defaultMediaStreamFactory = Web.defaultMediaStreamFactory;

const PRIVATE_IPV4 =
  /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}$/;

/** Max wait for ICE before sending INVITE/200 (fallback if no srflx/relay). */
const ICE_GATHER_TIMEOUT_WAN_MS = 6000;
const ICE_GATHER_TIMEOUT_LAN_MS = 5000;

/**
 * Fast STUN only — public TURN was slowing every dial by waiting out the full ICE timeout.
 * @param {string} serverIp
 */
function buildIceServers(serverIp) {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  if (serverIp) {
    servers.push({ urls: `stun:${serverIp}:3478` });
  }

  return servers;
}

/**
 * Singleton SIP softphone for Grandstream UCM6200 (WebRTC over WSS).
 */
class SipSoftphone {
  constructor() {
    this.userAgent = null;
    this.registerer = null;
    this.currentSession = null;

    /** Customer leg during attended (consultative) transfer. */
    this.primarySessionForTransfer = null;

    /** Agent ↔ transfer-target leg before REFER w/Replaces merge. */
    this.consultationSession = null;

    this.config = null;
    this.serverIp = null;
    /** @type {string | null} LAN IPv4 placed in SIP Contact and SDP */
    this.localIp = null;
    this.wsPort = 8089;

    /** @type {((invitation: Invitation) => void) | null} */
    this.onIncomingCall = null;

    /** @type {(() => void) | null} */
    this.onRegistered = null;

    /** @type {(() => void) | null} */
    this.onUnregistered = null;

    /**
     * Outbound/inbound call ended (remote decline, busy, cancel, hang up).
     * @type {((detail: { statusCode?: number, reasonPhrase?: string }) => void) | null}
     */
    this.onCallEnded = null;

    /** Last remote hangup / decline (for UI sync). */
    this.lastCallEnd = null;

    /** @type {{ reject: (error: Error) => void, cleanup: () => void } | null} */
    this._pendingRegistration = null;

    /** True when UCM is a public/WAN address (home client → cloud PBX). */
    this._isRemoteServer = false;

    /** Only use PC LAN IP when on the same subnet as a private UCM (not double-NAT WAN). */
    this._preferLanIp = false;

    /** Reused mic stream so WebRTC send path stays alive for the whole call. */
    this._localMicStream = null;
  }

  /** True when SDP should use WAN-oriented candidate filtering and rewriting. */
  _usesWanMediaPath() {
    return this._isRemoteServer && this.localIp && !PRIVATE_IPV4.test(this.localIp);
  }

  /**
   * @param {{ serverIp: string, extension: string, password: string, wsPort?: number, localIp?: string, preferLanIp?: boolean }} config
   */
  async initialize(config) {
    const {
      serverIp,
      extension,
      password,
      wsPort = 8089,
      localIp: configLocalIp,
      preferLanIp = false,
    } = config;

    if (!serverIp || !extension || !password) {
      throw new Error('serverIp, extension, and password are required.');
    }

    await this.shutdown();

    this.config = { serverIp, extension, password, wsPort, localIp: configLocalIp };
    this.serverIp = serverIp;
    this.wsPort = wsPort;

    const isRemoteServer = !PRIVATE_IPV4.test(serverIp);
    this._isRemoteServer = isRemoteServer;
    this._preferLanIp = preferLanIp !== false;
    const localIp = await this._resolveMediaIp(serverIp, configLocalIp, isRemoteServer);
    this.localIp = localIp;

    const contact = this._buildContactOptions(serverIp, localIp, extension, isRemoteServer);
    const iceServers = buildIceServers(serverIp);

    const wsServer = `wss://${serverIp}:${wsPort}/ws`;
    const uri = UserAgent.makeURI(`sip:${extension}@${serverIp}`);
    if (!uri) {
      throw new Error(`Failed to create SIP URI for extension ${extension}.`);
    }

    // Contact/Via host 127.0.0.1 for Grandstream rport (avoid *.invalid). Do not fix port to 5060 —
    // UCM binds the real WSS ephemeral port in 200 OK Contact (e.g. :51676).
    this.userAgent = new UserAgent({
      uri,
      hackIpInContact: '127.0.0.1',
      transportOptions: {
        server: wsServer,
        connectionTimeout: 20,
      },
      authorizationUsername: extension,
      authorizationPassword: password,
      displayName: extension,
      contactName: contact.contactName,
      contactParams: { transport: 'ws' },
      sipExtension100rel: SIPExtension.Unsupported,
      // We send 180 Ringing ourselves so state stays Initial until the user taps Accept.
      sendInitialProvisionalResponse: false,
      instanceIdAlwaysAdded: true,
      delegate: {
        onInvite: (invitation) => this._handleIncomingInvite(invitation),
        onDisconnect: (error) => {
          const message = error?.message
            ? `Lost connection to UCM: ${error.message}`
            : 'Lost connection to UCM.';
          this._failPendingRegistration(new Error(message));
        },
      },
      sessionDescriptionHandlerFactory: this._createSessionDescriptionHandlerFactory(),
      sessionDescriptionHandlerFactoryOptions: {
        iceGatheringTimeout: ICE_GATHER_TIMEOUT_WAN_MS,
        constraints: { audio: true, video: false },
        mediaStreamFactory: this._createMediaStreamFactory(),
        peerConnectionConfiguration: {
          iceServers,
          iceTransportPolicy: 'all',
          bundlePolicy: 'balanced',
          rtcpMuxPolicy: 'require',
        },
      },
      logLevel: 'log',
    });

    const registerContact = this.userAgent.contact.toString({ register: true });
    console.info(
      `[SipSoftphone] Registering ${extension} — ${contact.contactMode}, media ${this._usesWanMediaPath() ? 'WAN' : 'LAN'} IP ${localIp}, WSS ${serverIp}:${wsPort}`,
    );
    if (this._isRemoteServer) {
      console.info(
        '[SipSoftphone] UCM is reached via public/WAN address (often double NAT). Media uses STUN/TURN; configure UCM External Host + RTP forwarding.',
      );
    }
    console.info(`[SipSoftphone] REGISTER Contact header: ${registerContact}`);

    this.registerer = new Registerer(this.userAgent, {
      extraContactHeaderParams: ['ob'],
    });
    this.registerer.stateChange.addListener((state) => {
      if (state === RegistererState.Registered && typeof this.onRegistered === 'function') {
        this.onRegistered();
      }
      if (state === RegistererState.Unregistered && typeof this.onUnregistered === 'function') {
        this.onUnregistered();
      }
    });

    const registrationComplete = this._waitForRegistration(20000);

    // UserAgent owns transport.onConnect; chain registration after its handler.
    const previousOnConnect = this.userAgent.transport.onConnect;
    this.userAgent.transport.onConnect = () => {
      if (typeof previousOnConnect === 'function') {
        previousOnConnect();
      }
      this._registerExtension();
    };

    try {
      await this.userAgent.start();
      console.info('[SipSoftphone] WSS transport connected:', wsServer);
      await this._ensureMicrophoneAccess();
      await registrationComplete;
    } catch (error) {
      this._clearPendingRegistration();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  _waitForRegistration(timeoutMs = 20000) {
    if (!this.registerer) {
      return Promise.reject(new Error('SIP registerer was not created.'));
    }

    if (this.registerer.state === RegistererState.Registered) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };

      const timeoutId = setTimeout(() => {
        const transportState = this.userAgent?.transport?.state ?? 'unknown';
        const hint =
          transportState === 'Connected'
            ? 'WSS is up but REGISTER did not complete — check extension, password, and WebRTC on the extension.'
            : `WSS transport state: ${transportState}. Check UCM host, port (8089), firewall, and TLS certificate.`;
        finish(
          reject,
          new Error(`SIP registration timed out. ${hint}`),
        );
      }, timeoutMs);

      const onState = (state) => {
        if (state === RegistererState.Registered) {
          finish(resolve, undefined);
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.registerer?.stateChange.removeListener(onState);
        this._pendingRegistration = null;
      };

      this._pendingRegistration = { reject, cleanup };
      this.registerer.stateChange.addListener(onState);
    });
  }

  _failPendingRegistration(error) {
    if (this._pendingRegistration) {
      this._pendingRegistration.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  _clearPendingRegistration() {
    if (this._pendingRegistration) {
      this._pendingRegistration.cleanup();
    }
  }

  async _registerExtension() {
    if (!this.registerer) {
      return;
    }

    if (this.registerer.state === RegistererState.Registered) {
      return;
    }

    if (this.registerer.state === RegistererState.Terminated) {
      this._failPendingRegistration(
        new Error('SIP registerer terminated before registration could complete.'),
      );
      return;
    }

    try {
      await this.registerer.register({
        requestDelegate: {
          onReject: (response) => {
            const statusCode = response?.message?.statusCode ?? 0;
            const reasonPhrase = response?.message?.reasonPhrase ?? 'Rejected';
            const contacts = response?.message?.getHeaders?.('contact') ?? [];
            console.error('[SipSoftphone] REGISTER rejected:', statusCode, reasonPhrase, contacts);
            this._failPendingRegistration(
              new Error(`Registration rejected (${statusCode} ${reasonPhrase}). Check extension, password, and WebRTC on UCM.`),
            );
          },
          onAccept: (response) => {
            const contacts = response?.message?.getHeaders?.('contact') ?? [];
            console.info('[SipSoftphone] REGISTER accepted, Contact:', contacts);
            this._syncContactFromRegisterResponse(response);
          },
        },
      });
    } catch (error) {
      console.error('[SipSoftphone] Registration failed:', error);
      this._failPendingRegistration(
        error instanceof Error ? error : new Error('Registration request failed.'),
      );
    }
  }

  /**
   * UCM rewrites Contact host/port in REGISTER 200 OK (rport binding). Keep sip.js contact aligned.
   * @param {import('sip.js').IncomingResponse} response
   */
  _syncContactFromRegisterResponse(response) {
    const message = response?.message;
    const uri = this.userAgent?.contact?.uri;
    const extension = this.config?.extension;
    if (!message || !uri || !extension) {
      return;
    }

    const headerCount = message.getHeaders?.('contact')?.length ?? 0;
    for (let index = headerCount - 1; index >= 0; index -= 1) {
      const header = message.parseHeader('contact', index);
      if (!header?.uri || header.uri.user !== extension) {
        continue;
      }

      uri.host = header.uri.host;
      uri.port = header.uri.port;
      console.info(
        '[SipSoftphone] Synced Contact binding from UCM:',
        this.userAgent.contact.toString({ register: true }),
      );
      return;
    }
  }

  _handleIncomingInvite(invitation) {
    if (this.currentSession && this.currentSession.state !== SessionState.Terminated) {
      invitation.reject({ statusCode: 486, reasonPhrase: 'Busy Here' });
      return;
    }

    this.currentSession = invitation;
    this._attachIceDelegate(invitation);
    this._watchSessionLifecycle(invitation);

    if (invitation.state === SessionState.Initial) {
      invitation.progress({ statusCode: 180 }).catch((error) => {
        console.warn('[SipSoftphone] Failed to send 180 Ringing:', error);
      });
    }

    if (typeof this.onIncomingCall === 'function') {
      this.onIncomingCall(invitation);
    }
  }

  /**
   * Place an outbound call to another extension on the PBX.
   * @param {string} targetExtension
   * @param {HTMLAudioElement} remoteAudioElement
   */
  async makeCall(targetExtension, remoteAudioElement) {
    if (!this.userAgent) {
      throw new Error('SIP user agent is not initialized. Call initialize() first.');
    }

    if (this.isAttendedTransferActive()) {
      throw new Error('Cannot place a new call during an attended transfer.');
    }

    if (this.currentSession && this.currentSession.state !== SessionState.Terminated) {
      throw new Error('Another call is already in progress.');
    }

    const targetUri = UserAgent.makeURI(`sip:${targetExtension}@${this.serverIp}`);
    if (!targetUri) {
      throw new Error(`Invalid target extension: ${targetExtension}`);
    }

    await this._ensureMicrophoneAccess();

    const callSdhOptions = this._getCallSessionDescriptionHandlerOptions();

    const inviter = new Inviter(this.userAgent, targetUri, {
      earlyMedia: true,
      sessionDescriptionHandlerOptions: callSdhOptions,
      sessionDescriptionHandlerModifiers: this._getSdpSanitizeModifiers(),
    });

    inviter.delegate = this._createOutboundMediaDelegate(inviter, remoteAudioElement);

    inviter._softphoneCallUiEnded = false;
    this.currentSession = inviter;
    this.lastCallEnd = null;

    this._bindOutboundCallAudio(inviter, remoteAudioElement);
    this._watchSessionLifecycle(inviter);
    this._attachOutboundCallHandlers(inviter, remoteAudioElement);

    void inviter
      .invite({
        sessionDescriptionHandlerOptions: callSdhOptions,
        sessionDescriptionHandlerModifiers: this._getSdpSanitizeModifiers(),
        requestDelegate: this._createOutboundInviteDelegate(inviter, remoteAudioElement),
      })
      .then((outgoingInviteRequest) => {
        if (outgoingInviteRequest) {
          this._wrapOutboundInviteRejectDelegate(inviter, remoteAudioElement, outgoingInviteRequest);
        }
      })
      .catch((error) => {
        console.error('[SipSoftphone] Outbound INVITE failed:', error);
        this._handleCallEnded(inviter, {});
      });

    return inviter;
  }

  /**
   * Outbound-only: early media (180/183 SDP) + ICE hooks on every SessionDescriptionHandler.
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   */
  _bindOutboundCallAudio(inviter, remoteAudioElement) {
    if (!remoteAudioElement) {
      return;
    }

    inviter._softphoneAudioElement = remoteAudioElement;
    inviter._softphoneEarlyMediaTimers = [];

    const wireSdh = (sdh, label) => {
      if (!sdh) {
        return;
      }
      sdh._softphoneSession = inviter;
      sdh._softphoneAudioElement = remoteAudioElement;
      this._hookIceGathering(sdh);
    };

    inviter.stateChange.addListener((newState) => {
      if (newState === SessionState.Establishing) {
        wireSdh(inviter.sessionDescriptionHandler, 'establishing');
        this._scheduleEarlyMediaPlayback(inviter, remoteAudioElement, 'state-establishing');
      }

      if (newState === SessionState.Established) {
        wireSdh(inviter.sessionDescriptionHandler, 'established');
        this._scheduleEarlyMediaPlayback(inviter, remoteAudioElement, 'state-established');
      }

      if (newState === SessionState.Terminated) {
        this._clearEarlyMediaTimers(inviter);
      }
    });

    if (inviter.state === SessionState.Establishing || inviter.state === SessionState.Established) {
      wireSdh(inviter.sessionDescriptionHandler, 'initial');
      this._scheduleEarlyMediaPlayback(inviter, remoteAudioElement, 'state-initial');
    }
  }

  /**
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   */
  _createOutboundMediaDelegate(inviter, remoteAudioElement) {
    const iceDelegate = this._createIceDelegate();

    return {
      onSessionDescriptionHandler: (sessionDescriptionHandler, provisional) => {
        iceDelegate.onSessionDescriptionHandler(sessionDescriptionHandler);

        if (!sessionDescriptionHandler || !remoteAudioElement) {
          return;
        }

        sessionDescriptionHandler._softphoneSession = inviter;
        sessionDescriptionHandler._softphoneAudioElement = remoteAudioElement;
        this._hookIceGathering(sessionDescriptionHandler);

        const tag = provisional ? 'provisional-sdh' : 'confirmed-sdh';
        console.info(`[SipSoftphone] SessionDescriptionHandler (${tag}) — arming early media playback`);
        this._scheduleEarlyMediaPlayback(inviter, remoteAudioElement, tag);
      },
    };
  }

  /**
   * @param {import('sip.js').Session} session
   */
  _clearEarlyMediaTimers(session) {
    const timers = session._softphoneEarlyMediaTimers;
    if (Array.isArray(timers)) {
      timers.forEach((id) => clearTimeout(id));
    }
    session._softphoneEarlyMediaTimers = [];

    if (session._softphoneRejectTeardownTimer != null) {
      clearTimeout(session._softphoneRejectTeardownTimer);
      session._softphoneRejectTeardownTimer = null;
    }
    session._softphoneDelayedTeardown = false;
  }

  /**
   * @param {import('sip.js').Session} session
   * @param {HTMLAudioElement} remoteAudioElement
   * @param {string} reason
   */
  _scheduleEarlyMediaPlayback(session, remoteAudioElement, reason) {
    this._clearEarlyMediaTimers(session);
    if (!session._softphoneEarlyMediaTimers) {
      session._softphoneEarlyMediaTimers = [];
    }

    for (const delayMs of EARLY_MEDIA_PLAYBACK_DELAYS_MS) {
      const timerId = setTimeout(() => {
        if (session.state === SessionState.Terminated) {
          return;
        }
        void this._playEarlyMedia(session, remoteAudioElement, `${reason}+${delayMs}ms`);
      }, delayMs);
      session._softphoneEarlyMediaTimers.push(timerId);
    }
  }

  /**
   * Force receiver tracks on and attach peerConnection audio to the element (183/180 announcements).
   * @param {import('sip.js').Session} session
   * @param {HTMLAudioElement} remoteAudioElement
   * @param {string} label
   */
  async _playEarlyMedia(session, remoteAudioElement, label) {
    const sdh = session?.sessionDescriptionHandler;
    if (!sdh?.peerConnection || !remoteAudioElement) {
      return false;
    }

    try {
      sdh.enableReceiverTracks(true);
    } catch {
      // Peer may still be negotiating.
    }

    const played = await this._playRemoteFromSession(session, remoteAudioElement, `early-media-${label}`);
    if (played) {
      console.info(`[SipSoftphone] Early media playing (${label})`);
      callTonePlayer.stop();
    }
    return played;
  }

  /**
   * @param {*} response
   * @returns {string | null}
   */
  _extractSdpFromResponse(response) {
    const body = response?.message?.body;
    if (!body) {
      return null;
    }

    if (typeof body === 'string') {
      return body;
    }

    if (typeof body?.content === 'string') {
      return body.content;
    }

    if (typeof body?.body === 'string') {
      return body.body;
    }

    return null;
  }

  /**
   * @param {*} response
   */
  _sipResponseHasAudioSdp(response) {
    const sdp = this._extractSdpFromResponse(response);
    return Boolean(sdp?.includes('m=audio'));
  }

  /**
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   */
  _extractSipResponse(response) {
    const message = response?.message ?? response;
    return {
      statusCode: message?.statusCode,
      reasonPhrase: message?.reasonPhrase,
    };
  }

  _createOutboundInviteDelegate(inviter, remoteAudioElement) {
    return {
      onTrying: () => {
        console.info('[SipSoftphone] Outbound: remote trying');
      },
      onProgress: (response) => {
        const { statusCode, reasonPhrase } = this._extractSipResponse(response);
        const hasSdp = this._sipResponseHasAudioSdp(response);

        if (statusCode === 180) {
          console.info(`[SipSoftphone] Outbound: ringing${hasSdp ? ' (SDP)' : ''}`);
        }

        if ((statusCode === 183 || (statusCode === 180 && hasSdp)) && hasSdp) {
          console.info(
            `[SipSoftphone] Early media SIP ${statusCode} ${reasonPhrase ?? ''} — starting remote playback`,
          );
          this._scheduleEarlyMediaPlayback(inviter, remoteAudioElement, `sip-${statusCode}`);
        }
      },
      onRedirect: (response) => {
        this._handleCallEnded(inviter, this._extractSipResponse(response));
      },
      // onReject is handled by _wrapOutboundInviteRejectDelegate (must run before Inviter.onReject).
    };
  }

  /**
   * sip.js calls Inviter.onReject (→ Terminated → dispose) inside the core onReject handler.
   * Replace that handler so we can play announcement SDP before terminating.
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   * @param {*} outgoingInviteRequest
   */
  _wrapOutboundInviteRejectDelegate(inviter, remoteAudioElement, outgoingInviteRequest) {
    const delegate = outgoingInviteRequest?.delegate;
    if (!delegate?.onReject) {
      return;
    }

    delegate.onReject = (inviteResponse) => {
      this._onOutboundInviteReject(inviter, remoteAudioElement, inviteResponse, () => {
        if (typeof inviter.notifyReferer === 'function') {
          inviter.notifyReferer(inviteResponse);
        }
        inviter.onReject(inviteResponse);
      });
    };
  }

  /**
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   * @param {*} response
   * @param {() => void} continueSipJsReject
   */
  _onOutboundInviteReject(inviter, remoteAudioElement, response, continueSipJsReject) {
    const { statusCode, reasonPhrase } = this._extractSipResponse(response);
    const hasSdp = this._sipResponseHasAudioSdp(response);

    console.warn(
      `[SipSoftphone] Outbound INVITE rejected with ${statusCode} ${reasonPhrase}. Has Audio SDP: ${hasSdp}`,
    );

    inviter._softphoneLastRejectCode = statusCode;
    inviter._softphoneLastRejectReason = reasonPhrase;

    inviter._softphoneDelayedTeardown = true;
    callTonePlayer.stop();

    if (hasSdp && remoteAudioElement) {
      void this._applyRejectAnnouncementMedia(inviter, remoteAudioElement, response, statusCode);
    } else {
      console.info('[SipSoftphone] Internal rejection with no SDP — playing local busy tone.');
      void callTonePlayer.play('busy').catch((error) => {
        console.warn('[SipSoftphone] Failed to play local busy tone:', error);
      });
    }

    console.info('[SipSoftphone] Delaying call termination to allow tone/announcement playback.');
    inviter._softphoneRejectTeardownTimer = setTimeout(() => {
      inviter._softphoneRejectTeardownTimer = null;
      inviter._softphoneDelayedTeardown = false;

      callTonePlayer.stop();
      continueSipJsReject();
      this._handleCallEnded(inviter, { statusCode, reasonPhrase });
    }, REJECT_TEARDOWN_DELAY_MS);
  }

  /**
   * Apply SDP from a final reject (404/486/503…) and play announcement audio before dispose.
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   * @param {*} response
   * @param {number | undefined} statusCode
   */
  async _applyRejectAnnouncementMedia(inviter, remoteAudioElement, response, statusCode) {
    const sdp = this._extractSdpFromResponse(response);
    const sdh = inviter.sessionDescriptionHandler;

    if (sdp && sdh?.setDescription) {
      try {
        await sdh.setDescription(
          this._mungeRemoteSdpString(sdp),
          inviter.sessionDescriptionHandlerOptions ?? this._getCallSessionDescriptionHandlerOptions(),
          inviter.sessionDescriptionHandlerModifiers ?? this._getSdpSanitizeModifiers(),
        );
        console.info(`[SipSoftphone] Applied reject SDP for announcement (${statusCode})`);

        // Give Chromium WebRTC time to fire ontrack and populate remoteMediaStream before play.
        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch (error) {
        console.warn('[SipSoftphone] Failed to apply reject SDP:', error);
      }
    }

    this._scheduleEarlyMediaPlayback(inviter, remoteAudioElement, `reject-${statusCode}`);
    await this._playEarlyMedia(inviter, remoteAudioElement, `reject-${statusCode}`);
  }

  /**
   * Session state + forced cleanup when the far end declines (UCM may not always transition cleanly).
   * @param {Inviter} inviter
   * @param {HTMLAudioElement} remoteAudioElement
   */
  _attachOutboundCallHandlers(inviter, remoteAudioElement) {
    inviter.stateChange.addListener((newState) => {
      console.info(`[SipSoftphone] Outbound session state: ${newState}`);

      if (newState === SessionState.Terminated) {
        if (inviter._softphoneDelayedTeardown) {
          console.info('[SipSoftphone] Ignoring Terminated during delayed reject announcement');
          return;
        }

        this._clearEarlyMediaTimers(inviter);
        queueMicrotask(() => {
          this._handleCallEnded(inviter, {
            statusCode: inviter._softphoneLastRejectCode,
            reasonPhrase: inviter._softphoneLastRejectReason,
          });
        });
      }
    });
  }

  /**
   * Attach remote audio while the call is ringing (early media if the INVITE carries SDP).
   * @param {Invitation} invitation
   * @param {HTMLAudioElement} remoteAudioElement
   */
  bindIncomingRingAudio(invitation, remoteAudioElement) {
    if (!(invitation instanceof Invitation)) {
      return;
    }
    this._bindCallAudio(invitation, remoteAudioElement);
  }

  /**
   * Answer a ringing inbound call.
   * @param {HTMLAudioElement} remoteAudioElement
   */
  async answerCall(remoteAudioElement) {
    const session = this.currentSession;
    if (!(session instanceof Invitation)) {
      throw new Error('No incoming call to answer.');
    }

    if (session._softphoneAnswerPromise) {
      return session._softphoneAnswerPromise;
    }

    const answerTask = this._executeAnswerCall(session, remoteAudioElement);
    session._softphoneAnswerPromise = answerTask;
    try {
      await answerTask;
    } finally {
      session._softphoneAnswerPromise = null;
    }
  }

  /**
   * @param {Invitation} session
   * @param {HTMLAudioElement} remoteAudioElement
   */
  async _executeAnswerCall(session, remoteAudioElement) {
    await this._ensureMicrophoneAccess();

    const callSdhOptions = this._getCallSessionDescriptionHandlerOptions();

    this._attachIceDelegate(session);
    this._bindCallAudio(session, remoteAudioElement);

    const state = session.state;

    if (state === SessionState.Established) {
      this._enableSessionMedia(session, remoteAudioElement);
      return;
    }

    if (state === SessionState.Establishing) {
      console.info('[SipSoftphone] Answer already in progress, waiting for Established…');
      await this._waitForSessionState(session, SessionState.Established);
      this._enableSessionMedia(session, remoteAudioElement);
      return;
    }

    if (state !== SessionState.Initial) {
      throw new Error(`Cannot answer call in state ${state}.`);
    }

    await session.accept({
      sessionDescriptionHandlerOptions: callSdhOptions,
      sessionDescriptionHandlerModifiers: this._getSdpSanitizeModifiers(),
    });

    this._enableSessionMedia(session, remoteAudioElement);
  }

  /**
   * @param {import('sip.js').Session} session
   * @param {import('sip.js').SessionState} targetState
   */
  _waitForSessionState(session, targetState) {
    if (session.state === targetState) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        session.stateChange.removeListener(onState);
        reject(new Error('Timed out waiting for call to connect.'));
      }, 30000);

      const onState = (newState) => {
        if (newState === targetState) {
          clearTimeout(timeoutId);
          session.stateChange.removeListener(onState);
          resolve();
        } else if (newState === SessionState.Terminated) {
          clearTimeout(timeoutId);
          session.stateChange.removeListener(onState);
          reject(new Error('Call ended before answer completed.'));
        }
      };

      session.stateChange.addListener(onState);
    });
  }

  /**
   * End the active or ringing call.
   */
  async hangUp() {
    if (this.consultationSession && this.currentSession === this.consultationSession) {
      await this.cancelAttendedTransfer();
      return;
    }

    const session = this.currentSession;
    if (!session) {
      return;
    }

    this._clearEarlyMediaTimers(session);
    session._softphoneDelayedTeardown = false;

    this.currentSession = null;
    if (this.primarySessionForTransfer === session) {
      this._clearAttendedTransferState({ notifyCallEnded: false });
    }
    const state = session.state;

    try {
      if (session instanceof Invitation) {
        if (state === SessionState.Initial || state === SessionState.Establishing) {
          await session.reject();
          return;
        }
      }

      if (session instanceof Inviter && state === SessionState.Establishing) {
        await session.cancel();
        return;
      }

      if (state === SessionState.Established || state === SessionState.Terminating) {
        await session.bye();
        return;
      }

      await session.dispose();
    } catch (error) {
      console.error('[SipSoftphone] hangUp error:', error);
      try {
        await session.dispose();
      } catch {
        // Session may already be disposed.
      }
    }
  }

  /**
   * Step 1: Hold the customer and place a consultation call to the transfer target.
   * @param {string} targetExtension
   * @param {HTMLAudioElement} remoteAudioElement
   * @returns {Promise<Inviter>}
   */
  async startAttendedTransfer(targetExtension, remoteAudioElement) {
    if (!this.userAgent) {
      throw new Error('SIP user agent is not initialized. Call initialize() first.');
    }

    if (this.consultationSession) {
      throw new Error('A consultation call is already in progress.');
    }

    const primary = this.currentSession;
    if (!primary) {
      throw new Error('No active primary call session.');
    }

    if (primary.state !== SessionState.Established) {
      throw new Error(
        `Cannot start attended transfer in state ${primary.state}. The customer call must be connected.`,
      );
    }

    const target = String(targetExtension ?? '').trim();
    if (!target) {
      throw new Error('Consultation target extension is required.');
    }

    const targetUri = UserAgent.makeURI(`sip:${target}@${this.serverIp}`);
    if (!targetUri) {
      throw new Error(`Invalid consultation target extension: ${target}`);
    }

    this.primarySessionForTransfer = primary;
    primary._softphoneAttendedTransferPrimary = true;

    await this._setSessionHold(primary, true);
    console.info('[SipSoftphone] Primary customer call placed on consultation hold.');

    await this._ensureMicrophoneAccess();

    const callSdhOptions = this._getCallSessionDescriptionHandlerOptions();
    const inviter = new Inviter(this.userAgent, targetUri, {
      earlyMedia: true,
      sessionDescriptionHandlerOptions: callSdhOptions,
      sessionDescriptionHandlerModifiers: this._getSdpSanitizeModifiers(),
    });

    inviter.delegate = this._createOutboundMediaDelegate(inviter, remoteAudioElement);
    inviter._softphoneCallUiEnded = false;
    inviter._softphoneAttendedTransferConsultation = true;

    this.consultationSession = inviter;
    this.currentSession = inviter;

    this._bindOutboundCallAudio(inviter, remoteAudioElement);
    this._watchSessionLifecycle(inviter);
    this._attachOutboundCallHandlers(inviter, remoteAudioElement);

    console.info(`[SipSoftphone] Starting consultation call to: ${target}`);

    await inviter.invite({
      sessionDescriptionHandlerOptions: callSdhOptions,
      sessionDescriptionHandlerModifiers: this._getSdpSanitizeModifiers(),
      requestDelegate: this._createOutboundInviteDelegate(inviter, remoteAudioElement),
    });

    return inviter;
  }

  /**
   * Step 2: REFER the customer to the established consultation leg (attended transfer merge).
   */
  async completeAttendedTransfer() {
    const primary = this.primarySessionForTransfer;
    const consult = this.consultationSession;

    if (!primary || !consult) {
      throw new Error('Missing active sessions to complete attended transfer.');
    }

    if (primary.state !== SessionState.Established) {
      throw new Error(`Customer call is not connected (state ${primary.state}).`);
    }

    if (consult.state !== SessionState.Established) {
      throw new Error(
        `Consultation call is not connected (state ${consult.state}). Wait for the target to answer before completing transfer.`,
      );
    }

    if (!consult.dialog) {
      throw new Error('Consultation dialog is not established. Cannot send REFER with Replaces.');
    }

    console.info('[SipSoftphone] Completing attended transfer — REFER w/Replaces to merge legs.');

    try {
      callTonePlayer.stop();
      this._clearEarlyMediaTimers(primary);
      this._clearEarlyMediaTimers(consult);
      primary._softphoneDelayedTeardown = false;
      consult._softphoneDelayedTeardown = false;

      await primary.refer(consult);

      console.info('[SipSoftphone] Attended transfer REFER sent; agent legs will release.');

      this._clearAttendedTransferState({ notifyCallEnded: true });
    } catch (error) {
      console.error('[SipSoftphone] Attended transfer merge failed:', error);
      throw error;
    }
  }

  /**
   * Cancel attended transfer: end consultation and return to the held customer call.
   */
  async cancelAttendedTransfer() {
    const primary = this.primarySessionForTransfer;
    const consult = this.consultationSession;

    if (!primary && !consult) {
      return;
    }

    if (consult && consult.state !== SessionState.Terminated) {
      this._clearEarlyMediaTimers(consult);
      consult._softphoneDelayedTeardown = false;
      try {
        if (consult.state === SessionState.Established) {
          await consult.bye();
        } else {
          await consult.cancel();
        }
      } catch (error) {
        console.warn('[SipSoftphone] Failed to end consultation call:', error);
        try {
          await consult.dispose();
        } catch {
          // Ignore.
        }
      }
    }

    this.consultationSession = null;

    if (primary && primary.state === SessionState.Established) {
      this.currentSession = primary;
      try {
        await this._setSessionHold(primary, false);
      } catch (error) {
        console.warn('[SipSoftphone] Failed to resume customer call after cancel:', error);
      }
    } else {
      this.currentSession = null;
    }

    this._clearAttendedTransferState({ notifyCallEnded: false });
    console.info('[SipSoftphone] Attended transfer cancelled; returned to customer call.');
  }

  /** @returns {boolean} */
  isAttendedTransferActive() {
    return Boolean(this.primarySessionForTransfer || this.consultationSession);
  }

  /**
   * Blind transfer the active call to another extension (SIP REFER) — typical call-center agent flow.
   * @param {string} targetExtension
   */
  async transferCall(targetExtension) {
    if (this.isAttendedTransferActive()) {
      throw new Error(
        'Attended transfer in progress. Complete or cancel the consultation before a blind transfer.',
      );
    }

    const session = this.currentSession;
    if (!session) {
      throw new Error('No active call session to transfer.');
    }

    if (session.state !== SessionState.Established) {
      throw new Error(`Cannot transfer call in state ${session.state}. The call must be connected.`);
    }

    const target = String(targetExtension ?? '').trim();
    if (!target) {
      throw new Error('Transfer target extension is required.');
    }

    const targetUri = UserAgent.makeURI(`sip:${target}@${this.serverIp}`);
    if (!targetUri) {
      throw new Error(`Invalid transfer target extension: ${target}`);
    }

    console.info(`[SipSoftphone] Initiating blind transfer to: ${target}`);

    try {
      callTonePlayer.stop();
      this._clearEarlyMediaTimers(session);
      session._softphoneDelayedTeardown = false;

      await session.refer(targetUri);

      console.info(`[SipSoftphone] Transfer request (REFER) sent successfully to ${target}`);

      if (this.currentSession === session) {
        this.currentSession = null;
      }
    } catch (error) {
      console.error('[SipSoftphone] Call transfer failed:', error);
      throw error;
    }
  }

  /**
   * @param {import('sip.js').Session} session
   */
  _applyCallMediaState(session) {
    const sdh = session?.sessionDescriptionHandler;
    if (!sdh) {
      return;
    }

    const held = Boolean(session._softphoneHeld);
    const muted = Boolean(session._softphoneMuted);

    try {
      if (typeof sdh.enableReceiverTracks === 'function') {
        sdh.enableReceiverTracks(!held);
      }
      if (typeof sdh.enableSenderTracks === 'function') {
        sdh.enableSenderTracks(!held && !muted);
      }
    } catch (error) {
      console.warn('[SipSoftphone] applyCallMediaState failed:', error);
    }
  }

  /**
   * Mute or unmute the agent microphone on the active call (disables local audio send tracks).
   * @param {boolean} muted
   */
  setCallMuted(muted) {
    const session = this.currentSession;
    if (!session || session.state !== SessionState.Established) {
      throw new Error('No connected call to mute.');
    }

    if (!session.sessionDescriptionHandler) {
      throw new Error('Call media is not available.');
    }

    session._softphoneMuted = muted;
    this._applyCallMediaState(session);
  }

  /** @returns {boolean} */
  isCallMuted() {
    return Boolean(this.currentSession?._softphoneMuted);
  }

  /**
   * Place the active call on hold or resume (SIP re-INVITE with hold SDP).
   * @param {boolean} hold
   */
  async setCallHold(hold) {
    const session = this.currentSession;
    if (!session || session.state !== SessionState.Established) {
      throw new Error('No connected call to hold.');
    }

    await this._setSessionHold(session, hold);
  }

  /**
   * @param {import('sip.js').Session} session
   * @param {boolean} hold
   */
  async _setSessionHold(session, hold) {
    if (!session || session.state !== SessionState.Established) {
      throw new Error('No connected call to hold.');
    }

    if (Boolean(session._softphoneHeld) === hold) {
      return;
    }

    if (!session.sessionDescriptionHandler) {
      throw new Error('Call media is not available.');
    }

    session.sessionDescriptionHandlerOptionsReInvite = {
      ...(session.sessionDescriptionHandlerOptionsReInvite ?? {}),
      hold,
    };

    const previousHeld = Boolean(session._softphoneHeld);
    session._softphoneHeld = hold;
    this._applyCallMediaState(session);

    try {
      await session.invite({
        requestDelegate: {
          onReject: () => {
            session._softphoneHeld = previousHeld;
            this._applyCallMediaState(session);
            console.warn('[SipSoftphone] Hold re-INVITE rejected by remote party.');
          },
        },
      });
      session._softphoneHeld = hold;
      this._applyCallMediaState(session);
      console.info(`[SipSoftphone] Call ${hold ? 'on hold' : 'resumed'}.`);
    } catch (error) {
      session._softphoneHeld = previousHeld;
      this._applyCallMediaState(session);
      throw error;
    }
  }

  /**
   * @param {{ notifyCallEnded?: boolean }} [options]
   */
  _clearAttendedTransferState(options = {}) {
    const { notifyCallEnded = false } = options;

    if (this.primarySessionForTransfer) {
      delete this.primarySessionForTransfer._softphoneAttendedTransferPrimary;
    }
    if (this.consultationSession) {
      delete this.consultationSession._softphoneAttendedTransferConsultation;
    }

    this.primarySessionForTransfer = null;
    this.consultationSession = null;
    this.currentSession = null;

    if (notifyCallEnded && typeof this.onCallEnded === 'function') {
      this.onCallEnded(this.lastCallEnd ?? {});
    }
  }

  /** @returns {boolean} */
  isCallOnHold() {
    return Boolean(this.currentSession?._softphoneHeld);
  }

  async shutdown() {
    this._clearPendingRegistration();
    this._clearAttendedTransferState({ notifyCallEnded: false });
    this.currentSession = null;

    if (this.registerer) {
      try {
        if (this.registerer.state !== RegistererState.Terminated) {
          await this.registerer.unregister();
        }
      } catch {
        // Ignore unregister errors during teardown.
      }
      try {
        await this.registerer.dispose();
      } catch {
        // Ignore.
      }
      this.registerer = null;
    }

    if (this.userAgent) {
      try {
        await this.userAgent.stop();
      } catch {
        // Ignore.
      }
      this.userAgent = null;
    }

    this._releaseMicStream();

    this.config = null;
    this.serverIp = null;
    this.localIp = null;
    this.wsPort = 8089;
    this._isRemoteServer = false;
  }

  /**
   * True when the UCM is on the same private LAN subnet as this PC.
   * @param {string} serverIp
   * @param {string} localIp
   */
  _isLocalUcmServer(serverIp, localIp) {
    if (!PRIVATE_IPV4.test(serverIp)) {
      return false;
    }

    const server = serverIp.split('.').map((part) => Number.parseInt(part, 10));
    const local = localIp.split('.').map((part) => Number.parseInt(part, 10));

    if (server.length !== 4 || local.length !== 4) {
      return false;
    }

    return (
      server[0] === local[0] &&
      server[1] === local[1] &&
      server[2] === local[2]
    );
  }

  /**
   * SIP Contact in REGISTER must match what UCM returns in 200 OK.
   * @param {string} serverIp
   * @param {string} localIp
   * @param {string} extension
   */
  _buildContactOptions(serverIp, localIp, extension, isRemoteServer) {
    const onLan = !isRemoteServer && this._isLocalUcmServer(serverIp, localIp);

    return {
      contactName: extension,
      contactMode: onLan ? 'lan' : 'wan',
      contactParams: { transport: 'ws' },
    };
  }

  /**
   * True when this PC shares a /24 with a privately addressed UCM (same LAN, not double-NAT WAN).
   * @param {string} serverIp
   * @param {string} lanIp
   */
  _isOnSameLanAsServer(serverIp, lanIp) {
    return this._isLocalUcmServer(serverIp, lanIp);
  }

  /**
   * IP used in SDP / ICE.
   * UCM behind double NAT: client must advertise a reachable (usually STUN srflx) public IP;
   * UCM must expose its own public RTP address in NAT settings — the app cannot fix PBX-side NAT.
   * @param {string} serverIp
   * @param {string | undefined} configLocalIp
   * @param {boolean} isRemoteServer
   */
  async _resolveMediaIp(serverIp, configLocalIp, isRemoteServer) {
    if (configLocalIp?.trim()) {
      return configLocalIp.trim();
    }

    let electronLanIp = null;
    if (typeof window !== 'undefined' && window.electronAPI?.getLocalIp) {
      electronLanIp = await window.electronAPI.getLocalIp(serverIp);
      if (electronLanIp) {
        console.info(`[SipSoftphone] PC LAN IP (Electron): ${electronLanIp}`);
      }
    }

    const onSameLanAsUcm =
      electronLanIp && PRIVATE_IPV4.test(serverIp) && this._isOnSameLanAsServer(serverIp, electronLanIp);

    // Double-NAT / public UCM: STUN public IP first (home or internet clients).
    if (isRemoteServer) {
      const publicIp = await this._discoverIceIp({ preferSrflx: true });
      if (publicIp) {
        console.info(`[SipSoftphone] WAN media IP (STUN srflx): ${publicIp}`);
        return publicIp;
      }
    }

    // Same LAN as UCM (private UCM IP only) — matches desk phones on 192.168.111.x.
    if ((this._preferLanIp && onSameLanAsUcm) || onSameLanAsUcm) {
      console.info(`[SipSoftphone] Same LAN as UCM — media IP: ${electronLanIp}`);
      return electronLanIp;
    }

    if (!isRemoteServer && electronLanIp) {
      return electronLanIp;
    }

    if (electronLanIp && this._preferLanIp) {
      console.warn(
        `[SipSoftphone] preferLanIp set but PC (${electronLanIp}) is not on UCM subnet; LAN IP may not work through double NAT.`,
      );
      return electronLanIp;
    }

    const hostIp = await this._discoverIceIp({ preferSrflx: false });
    if (hostIp) {
      console.info(`[SipSoftphone] Fallback to Host Media IP: ${hostIp}`);
      return hostIp;
    }

    console.warn(
      '[SipSoftphone] STUN/Host IP discovery completely failed. Using hardcoded safe fallback.',
    );
    return '192.168.1.128';
  }

  /**
   * Discover IPv4 via Google STUN (host or server-reflexive candidates).
   * @param {{ preferSrflx?: boolean }} options
   */
  _discoverIceIp({ preferSrflx = false } = {}) {
    return new Promise((resolve) => {
      const pc = new RTCPeerConnection({
        iceServers: buildIceServers(this.serverIp),
        iceTransportPolicy: 'all',
      });

      let srflxIp = null;
      let hostIp = null;

      const timeout = setTimeout(() => {
        pc.close();
        resolve(preferSrflx ? srflxIp ?? hostIp : hostIp ?? srflxIp);
      }, 10000);

      const finish = (ip) => {
        clearTimeout(timeout);
        pc.close();
        resolve(ip);
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate?.candidate) {
          finish(preferSrflx ? srflxIp ?? hostIp : hostIp ?? srflxIp);
          return;
        }

        const candidate = event.candidate.candidate;
        const match = candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (!match) {
          return;
        }

        const ip = match[1];
        if (ip.startsWith('127.') || ip.startsWith('169.254.')) {
          return;
        }

        if (candidate.includes('typ srflx')) {
          srflxIp = srflxIp ?? ip;
          if (preferSrflx) {
            finish(ip);
          }
        } else if (candidate.includes('typ host')) {
          hostIp = hostIp ?? ip;
          if (!preferSrflx) {
            finish(ip);
          }
        }
      };

      pc.createDataChannel('ip-probe');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish(null));
    });
  }

  /**
   * Per-call SDH options — short timeout; gathering ends early once srflx/relay is found.
   */
  _getCallSessionDescriptionHandlerOptions() {
    return {
      constraints: { audio: true, video: false },
      iceGatheringTimeout: this._isRemoteServer
        ? ICE_GATHER_TIMEOUT_WAN_MS
        : ICE_GATHER_TIMEOUT_LAN_MS,
    };
  }

  /**
   * Stop waiting for ICE as soon as we have a routable candidate (avoids 15–20s delay before INVITE).
   * @param {import('sip.js').Web.SessionDescriptionHandler} sessionDescriptionHandler
   * @param {RTCPeerConnectionIceEvent} event
   */
  _maybeCompleteIceGatheringEarly(sessionDescriptionHandler, event) {
    if (typeof sessionDescriptionHandler.iceGatheringComplete !== 'function') {
      return;
    }

    const candidate = event.candidate;
    if (!candidate) {
      return;
    }

    const type = candidate.type;
    if (type === 'srflx' || type === 'relay') {
      console.info(`[SipSoftphone] ICE ${type} candidate — sending INVITE/answer without waiting for full gather`);
      sessionDescriptionHandler.iceGatheringComplete();
    }
  }

  /**
   * Wrap sip.js SDH so WAN munging runs on the final SDP (after ICE gather), not only pre-gather.
   */
  _createSessionDescriptionHandlerFactory() {
    return (session, options) => {
      const handler = defaultSessionDescriptionHandlerFactory(session, options);
      const originalGetDescription = handler.getDescription.bind(handler);

      handler.getDescription = (descriptionOptions, modifiers) =>
        originalGetDescription(descriptionOptions, modifiers).then((result) => {
          if (this._usesWanMediaPath() && result?.body) {
            result.body = this._mungeSdpString(result.body, 'post-ice-offer');
          }
          return result;
        });

      const originalSetDescription = handler.setDescription.bind(handler);
      handler.setDescription = (sdp, descriptionOptions, modifiers) =>
        originalSetDescription(
          this._mungeRemoteSdpString(sdp),
          descriptionOptions,
          modifiers,
        );

      return handler;
    };
  }

  /**
   * Fix UCM/Asterisk SDP before setRemoteDescription (no WAN IP rewrite).
   * @param {string} sdp
   */
  _mungeRemoteSdpString(sdp) {
    if (!sdp || typeof sdp !== 'string') {
      return sdp;
    }

    let out = this._stripG726FromSdp(sdp);
    out = this._ensureBundleGroup(out);
    out = this._mungeRemoteSdpForUcmNat(out);
    return out;
  }

  /**
   * UCM behind double NAT often puts 192.168.111.x in 183/200 SDP; rewrite to the public WSS host
   * so the browser can attempt ICE toward a reachable address (PBX must still forward RTP).
   * @param {string} sdp
   */
  _mungeRemoteSdpForUcmNat(sdp) {
    if (!this._isRemoteServer || !this.serverIp) {
      return sdp;
    }

    const publicHost = this.serverIp;
    let out = sdp;

    out = out.replace(/^c=IN IP4 \S+/gm, `c=IN IP4 ${publicHost}`);
    out = out.replace(/^o=(\S+\s+\d+\s+\d+\s+IN\s+IP4\s+)\S+/gm, `o=$1${publicHost}`);
    out = out.replace(
      /^(a=candidate:\S+\s+\d+\s+\w+\s+\d+\s+)(192\.168\.(?:\d{1,3}\.){2}\d{1,3}|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.){2}\d{1,3})(\s+\d+\s+typ host)/gm,
      `$1${publicHost}$3`,
    );

    if (out !== sdp) {
      console.info(
        `[SipSoftphone] Remote SDP: rewrote private UCM addresses → ${publicHost} (WAN client)`,
      );
    }

    return out;
  }

  /**
   * Inject a=group:BUNDLE when the PBX omits it (required if bundlePolicy is max-bundle).
   * @param {string} sdp
   */
  _ensureBundleGroup(sdp) {
    if (/a=group:BUNDLE/i.test(sdp) || !/^m=audio/im.test(sdp)) {
      return sdp;
    }

    const midMatch = sdp.match(/^a=mid:(\S+)/m);
    const mid = midMatch ? midMatch[1] : '0';
    const bundleLine = `a=group:BUNDLE ${mid}`;

    if (/^t=0 0$/m.test(sdp)) {
      const patched = sdp.replace(/^(t=0 0\r?\n)/m, `$1${bundleLine}\r\n`);
      console.info('[SipSoftphone] Remote SDP: added missing BUNDLE group');
      return patched;
    }

    const patched = sdp.replace(/^(m=audio)/m, `${bundleLine}\r\n$1`);
    console.info('[SipSoftphone] Remote SDP: added missing BUNDLE group before m=audio');
    return patched;
  }

  /**
   * @param {string} sdp
   */
  _stripG726FromSdp(sdp) {
    if (!sdp.includes('G726-32')) {
      return sdp;
    }

    const out = sdp
      .split(/\r?\n/)
      .filter((line) => !line.includes('G726-32'))
      .map((line) => {
        if (line.startsWith('m=audio')) {
          return line.replace(/\s2(\s|$)/, ' ');
        }
        return line;
      })
      .join('\r\n');

    console.info('[SipSoftphone] SDP G726-32 codec stripped to prevent WebRTC parsing failure');
    return out;
  }

  /**
   * Munge outbound SDP for server-side double NAT (cloud UCM at 192.168.111.x).
   * Rewrites session-level IPs to our STUN public WAN IP; keeps all ICE candidates intact.
   * @param {string} sdp
   * @param {string} [phase]
   */
  _mungeSdpString(sdp, phase = 'modifier') {
    const localIp = this.localIp;
    if (!sdp) {
      return sdp;
    }

    let out = sdp;

    if (localIp) {
      out = out.replace(/[\da-f-]+\.local/gi, localIp);
      out = out.replace(/c=IN IP4 \d+\.\d+\.\d+\.\d+/g, `c=IN IP4 ${localIp}`);
      out = out.replace(/^o=(\S+\s+\d+\s+\d+\s+IN\s+IP4\s+)\S+/gm, `o=$1${localIp}`);
    }

    console.info(`[SipSoftphone] SDP munged for Server-Side Double NAT (${phase}):`, localIp);
    return out;
  }

  _getSdpSanitizeModifiers() {
    const localIp = this.localIp;
    if (!localIp) return [];

    return [
      (sessionDescription) => {
        if (!sessionDescription.sdp) return Promise.resolve(sessionDescription);

        const sdp = this._mungeSdpString(sessionDescription.sdp, 'pre-ice');
        return Promise.resolve({ ...sessionDescription, sdp });
      },
    ];
  }

  /**
   * @param {import('sip.js').Session} session
   * @param {{ statusCode?: number, reasonPhrase?: string }} detail
   */
  _handleCallEnded(session, detail = {}) {
    if (session._softphoneDelayedTeardown) {
      return;
    }

    const statusCode = detail.statusCode ?? session._softphoneLastRejectCode;
    const reasonPhrase = detail.reasonPhrase ?? session._softphoneLastRejectReason;
    const hasSipDetail = Boolean(statusCode || reasonPhrase?.trim());

    if (statusCode) {
      session._softphoneLastRejectCode = statusCode;
      session._softphoneLastRejectReason = reasonPhrase;
    } else if (reasonPhrase?.trim()) {
      session._softphoneLastRejectReason = reasonPhrase;
    }

    if (hasSipDetail) {
      const label = formatCallEndStatus(statusCode, reasonPhrase);
      console.info(`[SipSoftphone] Call ended: ${statusCode ?? '?'} ${reasonPhrase ?? ''} → ${label}`.trim());
    }

    if (session === this.consultationSession) {
      this.consultationSession = null;
      const primary = this.primarySessionForTransfer;
      if (primary && primary.state !== SessionState.Terminated) {
        this.currentSession = primary;
        console.info('[SipSoftphone] Consultation ended; customer call remains on hold.');
        return;
      }
      this._clearAttendedTransferState({ notifyCallEnded: false });
    }

    if (session === this.primarySessionForTransfer) {
      const consult = this.consultationSession;
      this.primarySessionForTransfer = null;
      if (consult && consult.state !== SessionState.Terminated) {
        this._clearEarlyMediaTimers(consult);
        void consult.bye().catch(() => consult.dispose().catch(() => {}));
        this.consultationSession = null;
      }
    }

    if (this.currentSession === session) {
      this.currentSession = null;
    }

    if (
      this.primarySessionForTransfer === session ||
      (this.consultationSession === session && !this.primarySessionForTransfer)
    ) {
      this._clearAttendedTransferState({ notifyCallEnded: false });
    }

    this.lastCallEnd = { statusCode, reasonPhrase };

    const notifyUi = () => {
      if (typeof this.onCallEnded === 'function') {
        this.onCallEnded({ statusCode, reasonPhrase });
      }
    };

    // sip.js often hits Terminated before requestDelegate.onReject — allow a second notify with the real code.
    if (session._softphoneCallUiEnded) {
      if (hasSipDetail) {
        notifyUi();
      }
      return;
    }

    session._softphoneCallUiEnded = true;
    notifyUi();

    if (
      session instanceof Inviter &&
      session.state !== SessionState.Terminated &&
      session.state !== SessionState.Initial
    ) {
      void session.dispose().catch((error) => {
        console.warn('[SipSoftphone] dispose after remote end:', error);
      });
    }
  }

  _watchSessionLifecycle(session) {
    session.stateChange.addListener((newState) => {
      if (newState !== SessionState.Terminated) {
        return;
      }

      if (session._softphoneDelayedTeardown) {
        return;
      }

      queueMicrotask(() => {
        this._handleCallEnded(session, {
          statusCode: session._softphoneLastRejectCode,
          reasonPhrase: session._softphoneLastRejectReason,
        });
      });
    });
  }

  _releaseMicStream() {
    if (!this._localMicStream) {
      return;
    }

    this._localMicStream.getTracks().forEach((track) => track.stop());
    this._localMicStream = null;
  }

  /**
   * Reuse one microphone stream for all calls (do not stop tracks after permission probe).
   */
  _createMediaStreamFactory() {
    const baseFactory = defaultMediaStreamFactory();

    return (constraints) => {
      const wantsAudio = Boolean(constraints?.audio);
      const wantsVideo = Boolean(constraints?.video);

      if (!wantsAudio && !wantsVideo) {
        return baseFactory(constraints);
      }

      const liveMic =
        this._localMicStream?.getAudioTracks?.().some((track) => track.readyState === 'live') ?? false;

      if (wantsAudio && liveMic) {
        return Promise.resolve(this._localMicStream);
      }

      return baseFactory(constraints);
    };
  }

  async _ensureMicrophoneAccess() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API is unavailable in this environment.');
    }

    const live =
      this._localMicStream?.getAudioTracks?.().some((track) => track.readyState === 'live') ?? false;

    if (live) {
      return;
    }

    this._releaseMicStream();

    this._localMicStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });

    console.info('[SipSoftphone] Microphone stream acquired (kept open for WebRTC send path)');
  }

  _createIceDelegate() {
    return {
      onSessionDescriptionHandler: (sessionDescriptionHandler) => {
        this._hookIceGathering(sessionDescriptionHandler);
      },
    };
  }

  _attachIceDelegate(session) {
    const iceDelegate = this._createIceDelegate();
    const prior = session.delegate;

    session.delegate = {
      ...prior,
      onSessionDescriptionHandler(sessionDescriptionHandler, provisional) {
        iceDelegate.onSessionDescriptionHandler(sessionDescriptionHandler);
        prior?.onSessionDescriptionHandler?.(sessionDescriptionHandler, provisional);
      },
    };
  }

  _hookIceGathering(sessionDescriptionHandler) {
    if (!sessionDescriptionHandler?.peerConnection || sessionDescriptionHandler._softphoneIceHooked) {
      return;
    }

    sessionDescriptionHandler._softphoneIceHooked = true;
    const prior = sessionDescriptionHandler.peerConnectionDelegate;

    sessionDescriptionHandler.peerConnectionDelegate = {
      ...prior,
      onicecandidate: (event) => {
        this._maybeCompleteIceGatheringEarly(sessionDescriptionHandler, event);
        prior?.onicecandidate?.(event);
      },
      oniceconnectionstatechange: (event) => {
        const state = sessionDescriptionHandler.peerConnection?.iceConnectionState;
        console.info(`[SipSoftphone] ICE connection state: ${state}`);
        if (state === 'connected' || state === 'completed') {
          const session = sessionDescriptionHandler._softphoneSession;
          const audioEl = sessionDescriptionHandler._softphoneAudioElement;
          if (session && audioEl) {
            void this._playEarlyMedia(session, audioEl, `ice-${state}`);
          }
        }
        prior?.oniceconnectionstatechange?.(event);
      },
      onconnectionstatechange: (event) => {
        const state = sessionDescriptionHandler.peerConnection?.connectionState;
        console.info(`[SipSoftphone] Peer connection state: ${state}`);
        prior?.onconnectionstatechange?.(event);
      },
      ontrack: (event) => {
        prior?.ontrack?.(event);
        if (event.track?.kind === 'audio' && sessionDescriptionHandler._softphoneAudioElement) {
          const session = sessionDescriptionHandler._softphoneSession;
          const audioEl = sessionDescriptionHandler._softphoneAudioElement;
          void this._playEarlyMedia(session, audioEl, 'ontrack');
        }
      },
    };
  }

  _enableSessionMedia(session, remoteAudioElement) {
    const sdh = session?.sessionDescriptionHandler;
    const pc = sdh?.peerConnection;
    if (!sdh || !pc) {
      return;
    }

    try {
      sdh.enableSenderTracks(true);
      sdh.enableReceiverTracks(true);
    } catch (error) {
      console.warn('[SipSoftphone] enableSender/ReceiverTracks failed:', error);
    }

    const audioSenders = pc.getSenders().filter((sender) => sender.track?.kind === 'audio');
    const audioReceivers = pc.getReceivers().filter((receiver) => receiver.track?.kind === 'audio');

    console.info(
      `[SipSoftphone] Media check — ICE: ${pc.iceConnectionState}, connection: ${pc.connectionState}, ` +
        `audio senders: ${audioSenders.length}, receivers: ${audioReceivers.length}`,
    );

    if (remoteAudioElement) {
      this._playRemoteFromSession(session, remoteAudioElement, 'enable-session-media');
    }
  }

  /** Inbound / shared: play remote audio when the call connects. */
  _bindCallAudio(session, remoteAudioElement) {
    if (!remoteAudioElement) {
      return;
    }

    session._softphoneAudioElement = remoteAudioElement;

    const attachAndPlay = (label) => {
      const sdh = session.sessionDescriptionHandler;
      if (sdh) {
        sdh._softphoneSession = session;
        sdh._softphoneAudioElement = remoteAudioElement;
        this._hookIceGathering(sdh);
      }
      void this._playEarlyMedia(session, remoteAudioElement, label);
    };

    session.stateChange.addListener((newState) => {
      if (newState === SessionState.Establishing || newState === SessionState.Established) {
        attachAndPlay(newState);
      }
    });

    if (session.state === SessionState.Established || session.state === SessionState.Establishing) {
      attachAndPlay('initial');
    }
  }

  async _playRemoteFromSession(session, audioElement, label) {
    const sdh = session?.sessionDescriptionHandler;
    if (!sdh || !audioElement) {
      return false;
    }

    const stream = sdh.remoteMediaStream;
    if (!stream?.getAudioTracks?.().length) {
      const peerConnection = sdh.peerConnection;
      if (peerConnection) {
        const fallback = new MediaStream();
        peerConnection.getReceivers().forEach((receiver) => {
          if (receiver.track?.kind === 'audio') {
            fallback.addTrack(receiver.track);
          }
        });
        if (fallback.getTracks().length > 0) {
          return this._playStreamOnElement(fallback, audioElement, `${label}-receivers`);
        }
      }
      return false;
    }

    if (sdh._softphoneStreamHooked !== stream) {
      sdh._softphoneStreamHooked = stream;
      stream.onaddtrack = () => {
        console.info('[SipSoftphone] remoteMediaStream onaddtrack');
        audioElement.load?.();
        this._playStreamOnElement(stream, audioElement, `${label}-onaddtrack`);
      };
    }

    return this._playStreamOnElement(stream, audioElement, label);
  }

  async _playStreamOnElement(stream, audioElement, source) {
    if (!stream?.getAudioTracks?.().length) {
      return false;
    }

    audioElement.srcObject = stream;
    audioElement.autoplay = true;
    audioElement.muted = false;
    audioElement.volume = 1;

    try {
      await audioElement.play();
      console.info(`[SipSoftphone] Playing remote audio (${source})`);
      return true;
    } catch (error) {
      console.warn(`[SipSoftphone] audio.play() failed (${source}):`, error);
      return false;
    }
  }
}

export const sipService = new SipSoftphone();
export default sipService;

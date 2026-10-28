/* Test optionnel : Chrome/Edge installé, média synthétique, aucune permission du micro réel. */
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright-core');
const { createGameServer } = require('../server');

async function main() {
  const executablePath = [
    process.env.VOICE_BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((file) => file && existsSync(file));
  if (!executablePath)
    throw new Error('Installe Chrome/Edge ou indique son chemin dans VOICE_BROWSER_PATH.');
  const dir = mkdtempSync(path.join(tmpdir(), 'wcg-voice-browser-'));
  let app, browser;
  const errors = [];
  try {
    app = await createGameServer({
      databaseUrl: '',
      allowLocalStore: true,
      dataFile: path.join(dir, 'rooms.json'),
      voiceEnv: { WEBRTC_STUN_URLS: '' },
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const url = `http://localhost:${app.server.address().port}`;
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    async function player(name, code) {
      const context = await browser.newContext({
        permissions: ['microphone'],
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
      page.setDefaultTimeout(30000);
      await page.goto(url + (code ? '/room/' + code : '/'));
      if (!code) await page.locator('#choose-create').click();
      await page.locator('#nickname').fill(name);
      await page.locator('#nickname-form button').click();
      await page.locator(code ? '#join-form button' : '#create-form button').click();
      await page.locator('#room').waitFor({ state: 'visible' });
      return page;
    }
    const alice = await player('Alice');
    const code = await alice.evaluate(() => currentRoom.code);
    const bob = await player('Bob', code);
    await alice.locator('#voice-join').click();
    await bob.locator('#voice-join').click();
    const connected = async (page) => {
      try {
        await page.waitForFunction(
          () =>
            voice.active &&
            voice.peers.size > 0 &&
            [...voice.peers.values()].every((peer) => peer.pc.connectionState === 'connected'),
        );
      } catch (error) {
        console.error(
          'Diagnostic vocal',
          await page.evaluate(() => ({
            active: voice.active,
            pending: voice.pending,
            status: voice.status,
            peers: [...voice.peers.values()].map((peer) => ({
              connection: peer.pc.connectionState,
              ice: peer.pc.iceConnectionState,
              gathering: peer.pc.iceGatheringState,
              signaling: peer.pc.signalingState,
              polite: peer.polite,
              localType: peer.pc.localDescription?.type,
              remoteType: peer.pc.remoteDescription?.type,
            })),
          })),
        );
        throw error;
      }
    };
    await Promise.all([connected(alice), connected(bob)]);
    async function receivedAudio(page) {
      await page.waitForFunction(async () => {
        const stats = await Promise.all(
          [...voice.peers.values()].map((peer) => peer.pc.getStats()),
        );
        return stats.some((reports) =>
          [...reports.values()].some(
            (report) =>
              report.type === 'inbound-rtp' && report.kind === 'audio' && report.bytesReceived > 0,
          ),
        );
      });
    }
    await Promise.all([receivedAudio(alice), receivedAudio(bob)]);
    console.log('OK : audio WebRTC réel bidirectionnel entre deux navigateurs.');

    await bob.locator('#voice-mute').click();
    await alice.waitForFunction(() => [...voice.peers.values()][0].audio?.muted === true);
    assert.equal(await bob.evaluate(() => voice.stream.getAudioTracks()[0].enabled), false);
    await bob.locator('#voice-mute').click();
    await alice.waitForFunction(() => [...voice.peers.values()][0].audio?.muted === false);
    await alice.getByRole('button', { name: 'Ne plus entendre Bob', exact: true }).click();
    assert.equal(await alice.evaluate(() => [...voice.peers.values()][0].audio.muted), true);
    await alice.getByRole('button', { name: 'Réécouter Bob', exact: true }).click();
    await alice.locator('#voice-deafen').click();
    assert.equal(await alice.evaluate(() => [...voice.peers.values()][0].audio.muted), true);
    await alice.locator('#voice-deafen').click();
    await alice.getByRole('button', { name: 'Couper pour tous : Bob', exact: true }).click();
    await bob.waitForFunction(
      () =>
        voice.participants.find((p) => p.id === socket.id)?.hostMuted &&
        !voice.stream.getAudioTracks()[0].enabled,
    );
    assert.equal(await bob.locator('#voice-mute').isDisabled(), true);
    const forbidden = await bob.evaluate(() => voice.request('voice:mute', { muted: false }));
    assert.equal(forbidden.muted, true);
    await alice.getByRole('button', { name: 'Autoriser le micro : Bob', exact: true }).click();
    await bob.waitForFunction(() => !voice.participants.find((p) => p.id === socket.id)?.hostMuted);
    assert.equal(await bob.evaluate(() => voice.stream.getAudioTracks()[0].enabled), false);
    await bob.locator('#voice-mute').click();
    console.log('OK : mute personnel, écoute, blocage local et modération par l’hôte.');

    await alice.locator('#start').click();
    const charlie = await player('Charlie', code);
    assert.equal(
      await charlie.evaluate(() => currentRoom.players.find((p) => p.id === socket.id).spectator),
      true,
    );
    await charlie.locator('#voice-listen').click();
    await Promise.all([connected(charlie), connected(alice), connected(bob)]);
    assert.equal(await charlie.evaluate(() => Boolean(voice.stream)), false);
    await receivedAudio(charlie);
    await charlie.locator('#voice-mute').click();
    await alice.waitForFunction(async () => {
      const participant = voice.participants.find((p) => p.name === 'Charlie');
      const peer = voice.peers.get(participant?.id);
      if (!peer) return false;
      const stats = await peer.pc.getStats();
      return [...stats.values()].some(
        (report) =>
          report.type === 'inbound-rtp' && report.kind === 'audio' && report.bytesReceived > 0,
      );
    });
    console.log(
      'OK : spectateur en écoute seule, puis activation du micro et renégociation à trois.',
    );

    await bob.evaluate(() => socket.disconnect());
    await bob.waitForFunction(() => !voice.active && !voice.stream && voice.peers.size === 0);
    await bob.evaluate(() => socket.connect());
    await bob.waitForFunction(
      () => socket.connected && currentRoom.players.some((p) => p.id === socket.id),
    );
    assert.equal(await bob.evaluate(() => voice.active), false);
    await bob.locator('#voice-join').click();
    await connected(bob);
    await alice.locator('#leave').click();
    await charlie.waitForFunction(
      () => voice.host === socket.id && voice.participants.length === 2,
    );
    assert.equal(await alice.evaluate(() => voice.stream), null);
    await charlie.getByRole('button', { name: 'Couper pour tous : Bob', exact: true }).click();
    await bob.waitForFunction(() => voice.participants.find((p) => p.id === socket.id)?.hostMuted);
    console.log(
      'OK : reconnexion sans rallumer le micro et transfert de modération au nouvel hôte.',
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

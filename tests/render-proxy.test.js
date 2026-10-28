const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clientIp, proxyEnabled, Analytics } = require('../lib/analytics');
const request = chain => ({headers:{'x-forwarded-for':chain},socket:{remoteAddress:'::ffff:10.0.0.5'}});
test('Render : le visiteur public est choisi avant les proxys privés et publics de fin de chaîne', () => {
  assert.equal(clientIp(request('8.8.8.8, 172.16.0.3, 10.0.0.6'),true),'8.8.8.8');
  assert.equal(clientIp(request('8.8.8.8, 1.1.1.1, 10.0.0.6'),true),'8.8.8.8');
  assert.equal(clientIp(request('not-an-ip, 192.168.1.1, 8.8.4.4, 10.0.0.6'),true),'8.8.4.4');
  assert.equal(clientIp(request('2001:4860:4860::8888, 10.0.0.6'),true),'2001:4860:4860::8888');
});
test('En-têtes ignorés sans proxy configuré ; pas de géolocalisation publique inventée', () => {
  assert.equal(clientIp(request('8.8.8.8'),false),'10.0.0.5');
  assert.equal(clientIp(request('garbage, 192.168.1.1'),true),'10.0.0.5');
  assert.equal(clientIp({headers:{},socket:{remoteAddress:'::1'}},false),'::1');
});
test('Render détecté automatiquement uniquement si TRUST_PROXY n’est pas défini', () => {
  assert.equal(proxyEnabled({RENDER:'true'}),true);
  assert.equal(proxyEnabled({RENDER:'true',TRUST_PROXY:'0'}),false);
  assert.equal(proxyEnabled({TRUST_PROXY:'1'}),true);
  assert.equal(proxyEnabled({}),false);
});
test('Statistiques : l’API reçoit bien le visiteur public et non le relais Render', async () => {
  let received;
  const analytics = new Analytics({trustProxy:true,geolocation:{resolve:async ip => { received = ip; return 'TG'; }}});
  analytics.connect({id:'render-test',handshake:{auth:{}},request:request('8.8.8.8, 172.16.0.3')});
  await analytics.close();
  assert.equal(received,'8.8.8.8');
  assert.equal(analytics.online.get('render-test').ipScope,'public');
  assert.equal(analytics.events[0].country,'TG');
  assert.equal(JSON.stringify(analytics.events).includes('8.8.8.8'),false);
});

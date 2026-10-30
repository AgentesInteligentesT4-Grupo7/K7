import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { HtmlParaPng } from '../src/utils/HtmlParaPng.js';

const render = new HtmlParaPng();
after(() => render.fechar());

/** Abre o Chrome/Edge da máquina; sem navegador instalado (ex.: servidor de CI), o teste é pulado. */
async function disponivel(): Promise<boolean> {
  try {
    await render.render('<p>ok</p>');
    return true;
  } catch {
    return false;
  }
}

describe('HTML → PNG (print de layout)', () => {
  it('largura pedida × escala, altura do conteúdo, sem rede', async (t) => {
    if (!(await disponivel())) return t.skip('sem Chrome/Edge nesta máquina');
    let pedidos = 0;
    const server = http.createServer((_req, res) => {
      pedidos++;
      res.end('x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const html = `<body style="margin:0"><div style="height:150px;background:#2e7d32"></div>
        <img src="${url}/x.png"><script>fetch('${url}/dados').catch(() => {});</script></body>`;
      const png = await render.render(html, { largura: 300, escala: 2 });
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 600, 'largura × escala');
      assert.ok(png.readUInt32BE(20) >= 300 && png.readUInt32BE(20) < 400, 'altura do conteúdo, não da janela');
      assert.equal(pedidos, 0, 'a página não acessa a rede');
    } finally {
      server.close();
    }
  });
});

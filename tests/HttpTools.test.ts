import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HttpTool, type HttpRequest, type HttpResponse, httpsTransport } from '../src/modules/http/HttpTool.js';
import { parseHttpToolSpec } from '../src/modules/http/HttpToolSpec.js';
import { loadHttpTools } from '../src/modules/http/loadHttpTools.js';
import { isBlockedAddress } from '../src/net/NetworkGuard.js';

const CLIMA = `nome: previsao_do_tempo
descricao: Previsão do tempo atual para uma coordenada
url: https://api.open-meteo.com/v1/forecast
parametros:
  latitude: { tipo: number, descricao: Latitude }
  longitude: { tipo: number, descricao: Longitude }
  unidade: { tipo: string, opcoes: [celsius, fahrenheit], opcional: true }
fixos: { current: "temperature_2m,weather_code" }
resposta: { campos: [current.temperature_2m, current.weather_code] }
`;

/** Transporte falso: registra a requisição e devolve a resposta configurada. */
function fakeTransport(response: Partial<HttpResponse> = {}) {
  const requests: HttpRequest[] = [];
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    requests.push(request);
    return { status: 200, contentType: 'application/json', body: '{}', truncated: false, ...response };
  };
  return { requests, transport };
}

describe('Ferramentas HTTP declarativas: validação do YAML', () => {
  it('lê nome, parâmetros, fixos e campos; o schema do LLM marca obrigatórios e opções', () => {
    const spec = parseHttpToolSpec(CLIMA, 'clima.yaml');
    assert.equal(spec.metodo, 'GET');
    assert.deepEqual(spec.hostsPermitidos, ['api.open-meteo.com']);
    assert.equal(spec.limiteBytes, 100 * 1024);
    const tool = new HttpTool(spec, {});
    assert.deepEqual(tool.parameters.required, ['latitude', 'longitude']);
    assert.deepEqual(tool.parameters.properties.unidade?.enum, ['celsius', 'fahrenheit']);
    assert.match(tool.description, /consulta externa em api\.open-meteo\.com/);
  });

  it('recusa http, rede local, IP interno, marcador no host, parâmetro não declarado e autenticação incompleta', () => {
    const base = 'nome: teste_api\ndescricao: x\n';
    const bad: Array<[string, RegExp]> = [
      [`${base}url: http://api.exemplo.com/x`, /deve usar https/],
      [`${base}url: https://localhost:8080/x`, /rede local/],
      [`${base}url: https://192.168.0.10/x`, /endereço interno/],
      [`${base}url: https://[::1]/x`, /endereço interno/],
      [`${base}url: https://{host}.exemplo.com/x\nparametros: { host: { tipo: string } }`, /endereço do servidor/],
      [`${base}url: https://api.exemplo.com/{id}`, /usa \{id\}, que não está em "parametros"/],
      [`${base}url: https://api.exemplo.com/x\nautenticacao: { tipo: header, variavel: CHAVE }`, /autenticacao.nome/],
      [`${base}url: https://api.exemplo.com/x\nhosts_permitidos: [outro.com]`, /não inclui o host/],
      [`nome: Teste\ndescricao: x\nurl: https://api.exemplo.com`, /campo "nome"/],
      [`${base}url: https://user:senha@api.exemplo.com`, /usuário\/senha/],
    ];
    for (const [yaml, error] of bad) assert.throws(() => parseHttpToolSpec(yaml, 't.yaml'), error, yaml);
  });

  it('bloqueia endereços internos (IPv4, IPv6 e IPv4 mapeado)', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.ok(isBlockedAddress(ip), ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isBlockedAddress(ip), ip);
  });
});

describe('Ferramentas HTTP declarativas: chamada', () => {
  it('GET: fixos + argumentos na query, extrai só os campos e marca como dado externo', async () => {
    const { requests, transport } = fakeTransport({ body: '{"current":{"temperature_2m":27.5,"weather_code":1},"lixo":"x"}' });
    const tool = new HttpTool(parseHttpToolSpec(CLIMA, 'clima.yaml'), {}, transport);
    const { output } = await tool.execute({ latitude: -16.68, longitude: -49.25 });
    const url = requests[0]!.url;
    assert.equal(url.searchParams.get('latitude'), '-16.68');
    assert.equal(url.searchParams.get('current'), 'temperature_2m,weather_code');
    assert.match(output, /^\[DADOS EXTERNOS de api\.open-meteo\.com/);
    assert.match(output, /"current\.temperature_2m":27\.5/);
    assert.doesNotMatch(output, /lixo/);
  });

  it('parâmetro de caminho vai codificado; argumentos fora do schema são recusados', async () => {
    const { requests, transport } = fakeTransport();
    const spec = parseHttpToolSpec('nome: cotacao\ndescricao: Cotação\nurl: https://economia.awesomeapi.com.br/json/last/{par}\nparametros: { par: { tipo: string } }', 'c.yaml');
    const tool = new HttpTool(spec, {}, transport);
    await tool.execute({ par: 'USD-BRL/../../admin?x=1' });
    assert.equal(requests[0]!.url.pathname, '/json/last/USD-BRL%2F..%2F..%2Fadmin%3Fx%3D1');
    await assert.rejects(tool.execute({ par: 'USD-BRL', extra: 1 }), /Parâmetro desconhecido/);
  });

  it('a chave vem do .env, vai no cabeçalho/query/bearer e nunca aparece na resposta', async () => {
    const env = { PRECOS_API_KEY: 'segredo-123' };
    for (const [auth, check] of [
      ['{ tipo: header, nome: X-Api-Key, variavel: PRECOS_API_KEY }', (r: HttpRequest) => r.headers['x-api-key']],
      ['{ tipo: bearer, variavel: PRECOS_API_KEY }', (r: HttpRequest) => r.headers.authorization?.replace('Bearer ', '')],
      ['{ tipo: query, nome: key, variavel: PRECOS_API_KEY }', (r: HttpRequest) => r.url.searchParams.get('key')],
    ] as const) {
      const { requests, transport } = fakeTransport({ contentType: 'text/plain', body: 'eco: segredo-123' });
      const spec = parseHttpToolSpec(`nome: precos\ndescricao: Preços\nurl: https://api.precos.com/v1\nautenticacao: ${auth}`, 'p.yaml');
      const tool = new HttpTool(spec, env, transport);
      assert.doesNotMatch(JSON.stringify(tool.toDefinition()), /segredo|PRECOS_API_KEY/);
      const { output } = await tool.execute({});
      assert.equal(check(requests[0]!), 'segredo-123');
      assert.match(output, /eco: \[chave omitida\]/);
    }
    const spec = parseHttpToolSpec('nome: precos\ndescricao: P\nurl: https://api.precos.com\nautenticacao: { tipo: bearer, variavel: FALTA }', 'p.yaml');
    await assert.rejects(new HttpTool(spec, {}, fakeTransport().transport).execute({}), /precisa de FALTA no \.env do perfil/);
  });

  it('POST envia JSON; erro HTTP e resposta cortada aparecem para o LLM', async () => {
    const { requests, transport } = fakeTransport({ status: 503, contentType: 'text/plain', body: 'fora do ar', truncated: true });
    const spec = parseHttpToolSpec('nome: busca\ndescricao: Busca\nmetodo: POST\nurl: https://api.busca.com/q\nparametros: { termo: { tipo: string } }', 'b.yaml');
    const { output } = await new HttpTool(spec, {}, transport).execute({ termo: 'fone' });
    assert.equal(requests[0]!.body, '{"termo":"fone"}');
    assert.match(output, /HTTP 503 \(erro do serviço\)\nfora do ar\n\[\.\.\. resposta cortada em 100 KB/);
  });

  it('o transporte real recusa nomes que resolvem para a rede local (DNS validado na conexão)', async () => {
    const request: HttpRequest = { method: 'GET', url: new URL('https://localhost:9/'), headers: {}, timeoutMs: 3000, maxBytes: 1000 };
    await assert.rejects(httpsTransport(request), /endereço interno/);
  });
});

describe('Carregamento de ferramentas do perfil', () => {
  it('lê ferramentas/*.yaml, ignora inválidas e nomes repetidos ou reservados', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferramentas-'));
    fs.writeFileSync(path.join(dir, 'clima.yaml'), CLIMA);
    fs.writeFileSync(path.join(dir, 'ruim.yaml'), 'nome: ruim\ndescricao: x\nurl: http://inseguro.com');
    fs.writeFileSync(path.join(dir, 'repetida.yml'), CLIMA);
    fs.writeFileSync(path.join(dir, 'reservada.yaml'), 'nome: obter_data_hora\ndescricao: x\nurl: https://a.com');
    fs.writeFileSync(path.join(dir, 'leia-me.md'), 'não é ferramenta');
    const tools = loadHttpTools(dir, {}, new Set(['obter_data_hora']));
    assert.deepEqual(tools.map((t) => t.name), ['previsao_do_tempo']);
    assert.deepEqual(loadHttpTools(path.join(dir, 'nao-existe'), {}), []);
  });
});

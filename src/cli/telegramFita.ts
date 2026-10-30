import fs from 'node:fs';
import readline from 'node:readline/promises';
import { qrTerminal } from '../canais/telegram/acesso/convite.js';
import type { AccessStatus } from '../canais/telegram/acesso/TelegramAccessStore.js';
import { FitaTelegram } from '../canais/telegram/configuracao/FitaTelegram.js';

type Option = (name: string) => string | undefined;

const ICON: Record<AccessStatus, string> = { ativo: '✅', pendente: '🙋', bloqueado: '⛔' };

/**
 * `npm run perfil -- bot <fita> [--token | --gerente]`: conecta e configura o bot do Telegram da fita.
 * Sem opção: se a fita já tem token, reaplica nome/descrição/comandos/foto; se não, explica os dois caminhos.
 */
export async function botCommand(fita: string, args: string[], option: Option): Promise<void> {
  const telegram = new FitaTelegram(fita);
  if (args.includes('--gerente')) {
    const managerToken = process.env.TELEGRAM_GERENTE_TOKEN?.trim();
    if (!managerToken) throw new Error('defina TELEGRAM_GERENTE_TOKEN no .env do K7 (o token do bot gerente, criado no @BotFather com o modo de gerenciar bots ligado)');
    const { link, gerente, sugestao } = await telegram.managedLink(managerToken);
    console.log(`\n🤖 Criar o bot da fita "${fita}" pelo gerente @${gerente.username} (sugestão: @${sugestao}).`);
    console.log('   Abra no celular (ou escaneie) e confirme no Telegram; pode trocar o nome e o @ antes de confirmar:\n');
    console.log(await qrTerminal(link));
    console.log(`   ${link}\n\n⏳ Esperando a confirmação (até 10 min)…`);
    const created = await telegram.completeManaged(managerToken, 10 * 60_000);
    console.log(`✅ Bot @${created.bot.username} criado por ${created.criadoPor.nome} e conectado à fita (token gravado no .env da fita).`);
    return printSync(created);
  }

  let token = option('token');
  if (args.includes('--token') && !token) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    token = (await rl.question('Cole o token do @BotFather: ')).trim();
    rl.close();
  }
  if (token) {
    const result = await telegram.connectToken(token);
    console.log(`✅ Bot @${result.bot.username} conectado à fita "${fita}" (token gravado no .env da fita, não mostrado aqui).`);
    return printSync(result);
  }

  const bot = await telegram.bot();
  if (!bot) {
    console.log(
      [
        `A fita "${fita}" ainda não tem bot. Dois jeitos:`,
        `  npm run perfil -- bot ${fita} --gerente   cria pelo bot gerente do K7 (você só confirma no celular)`,
        `  npm run perfil -- bot ${fita} --token     cola o token de um bot criado no @BotFather`,
      ].join('\n'),
    );
    return;
  }
  console.log(`🔄 Reaplicando o perfil no bot @${bot.username}…`);
  printSync(await telegram.sync());
}

/** `npm run perfil -- convite <fita> [--nome Maria] [--dias 7] [--usos 1]`: link + QR no terminal e em PNG. */
export async function inviteCommand(fita: string, option: Option): Promise<void> {
  const telegram = new FitaTelegram(fita);
  const nome = option('nome');
  const { invite, link, png, aviso } = await telegram.invite({
    ...(nome ? { nome } : {}),
    ...(option('dias') ? { dias: Number(option('dias')) } : {}),
    ...(option('usos') ? { usos: Number(option('usos')) } : {}),
  });
  const file = telegram.invitePngPath(invite.codigo);
  fs.writeFileSync(file, png);
  console.log(`\n🎟️ Convite${invite.nome ? ` para ${invite.nome}` : ''} · ${invite.usosMax === 1 ? 'uso único' : `${invite.usosMax} usos`} · vale até ${invite.expiraEm}\n`);
  console.log(await qrTerminal(link));
  console.log(`   ${link}\n   QR em PNG: ${file}`);
  if (aviso) console.log(`\n⚠️ ${aviso}`);
}

/** `npm run perfil -- acessos <fita> [liberar|bloquear|remover <id>] [cancelar-convite <código>]` */
export async function accessCommand(fita: string, args: string[]): Promise<void> {
  const telegram = new FitaTelegram(fita);
  const [action, target] = args.slice(2);
  if (action === 'cancelar-convite' && target) {
    console.log(telegram.revokeInvite(target) ? '🗑️ Convite cancelado.' : 'Convite não encontrado.');
    return;
  }
  if (action && target) {
    const userId = Number(target);
    if (!Number.isSafeInteger(userId)) throw new Error(`ID inválido: ${target}`);
    if (action === 'remover') return void console.log(telegram.removePerson(userId) ? '🗑️ Removido.' : 'Não encontrado.');
    const status: AccessStatus | undefined = action === 'liberar' ? 'ativo' : action === 'bloquear' ? 'bloqueado' : undefined;
    if (!status) throw new Error('use liberar, bloquear, remover ou cancelar-convite');
    const entry = telegram.setStatus(userId, status);
    return void console.log(entry ? `${ICON[entry.status]} ${entry.nome} agora está ${entry.status}.` : 'Não encontrado.');
  }
  const view = telegram.overview();
  console.log(`\n👥 Bot da fita "${fita}" · modo "${view.modo}"${view.modo === 'convite' ? ` · pedidos ${view.pedidos ? 'ligados' : 'desligados'}` : ''}`);
  console.log(`   Donos (.env): ${view.donos.join(', ') || '(nenhum)'}`);
  if (!view.pessoas.length) console.log('   Ninguém mais tem acesso.');
  for (const p of view.pessoas) {
    console.log(`   ${ICON[p.status]} ${p.nome}${p.username ? ` (@${p.username})` : ''} [${p.userId}] · ${p.origem}${p.ultimoContato ? ` · visto ${p.ultimoContato}` : ''}`);
  }
  const open = view.convites.filter((c) => !c.revogado && c.usos < c.usosMax);
  if (open.length) console.log(`\n🎟️ Convites em aberto: ${open.map((c) => `${c.codigo.slice(0, 6)}… ${c.nome ?? ''} (até ${c.expiraEm.slice(0, 10)})`).join(', ')}`);
}

function printSync(result: { feitos: string[]; falhas: string[] }): void {
  if (result.feitos.length) console.log(`   Aplicado: ${result.feitos.join(', ')}`);
  for (const falha of result.falhas) console.log(`   ⚠️ ${falha}`);
}

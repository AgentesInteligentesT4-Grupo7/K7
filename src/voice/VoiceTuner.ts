import { UserFacingError } from '../errors/AppErrors.js';
import type { SynthesizedAudio } from './tts/TextToSpeech.js';
import type { VoiceCloneService } from './VoiceCloneService.js';
import { type MirrorSource, type VoiceMirror, VoiceMirror as Mirror } from './VoiceMirror.js';
import { ADJUST_HELP, type VoiceParams, describeParams, parseAdjustment, speedToMatch } from './VoiceParams.js';

/** O que foi gerado por último numa conversa: é isso que o /ajustar refaz e o /salvarvoz guarda. */
type Session =
  | { kind: 'teste'; source: MirrorSource; voice?: string; params: VoiceParams; generatedSeconds: number | null; expiresAt: number }
  | { kind: 'falar'; text: string; voice: string; params: VoiceParams; generatedSeconds: number | null; expiresAt: number };

export interface TuneOutput {
  audio: SynthesizedAudio;
  /** Relatório e próximos passos, em texto puro. */
  report: string;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const newSeed = () => 1 + Math.floor(Math.random() * 2_000_000_000);

/**
 * Ajuste fino da voz clonada em conversa (Telegram e terminal): testa com um áudio de referência,
 * refaz com "mais emoção", "mais lento", "igualar"... mantendo a mesma semente, e salva quando ficar bom.
 */
export class VoiceTuner {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly service: VoiceCloneService,
    private readonly mirror: VoiceMirror,
  ) {}

  /**
   * /testarvoz: transcreve o áudio e o fala de novo, com a própria amostra (espelho) ou, com `voiceName`,
   * com uma voz cadastrada (o áudio enviado vira o "modelo" de ritmo e duração a imitar).
   */
  async test(key: string, audioPath: string, extension: string, voiceName?: string): Promise<TuneOutput> {
    const voice = voiceName ? this.service.resolveName(voiceName) : undefined;
    const source = await this.mirror.prepare(audioPath, extension);
    const params: VoiceParams = { ...(voice ? this.service.params(voice) : {}), seed: newSeed() };
    const result = await this.mirror.render(source, params, voice);
    this.sessions.set(key, { kind: 'teste', source, ...(voice ? { voice } : {}), params, generatedSeconds: result.generatedSeconds, expiresAt: Date.now() + SESSION_TTL_MS });
    const save = voice ? `Gostou? /salvarvoz guarda estes ajustes na voz "${voice}".` : 'Gostou? /salvarvoz <nome> guarda a amostra com estes ajustes.';
    return { audio: result.audio, report: `${Mirror.report(source, result, params, [], voice)}\n\n${ADJUST_HELP}\n${save}` };
  }

  /** /falar: lembra a última fala para o /ajustar (o envio continua com o fluxo normal). */
  remember(key: string, text: string, voiceName?: string): void {
    const voice = this.service.resolveName(voiceName);
    this.sessions.set(key, { kind: 'falar', text, voice, params: this.service.params(voice), generatedSeconds: null, expiresAt: Date.now() + SESSION_TTL_MS });
  }

  async adjust(key: string, request: string): Promise<TuneOutput> {
    const session = this.session(key);
    const { params, changes, matchDuration } = parseAdjustment(request, session.params);
    if (matchDuration) {
      if (session.kind !== 'teste') throw new UserFacingError('"igualar" compara com o áudio original: use depois de um /testarvoz.');
      if (!session.source.originalSeconds || !session.generatedSeconds) throw new UserFacingError('Não consegui medir as durações para igualar (formato sem duração, ex.: mp3).');
      params.speedFactor = speedToMatch(session.params, session.generatedSeconds, session.source.originalSeconds);
      changes.push(`igualar a duração (velocidade ${String(params.speedFactor).replace('.', ',')})`);
    }
    if (!changes.length) throw new UserFacingError(`Não entendi o ajuste "${request.trim() || '(vazio)'}".\n${ADJUST_HELP}`);
    // Mesma semente entre um ajuste e outro: a diferença ouvida vem do ajuste, não do acaso.
    params.seed ??= newSeed();
    session.params = params;
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    if (session.kind === 'teste') {
      const result = await this.mirror.render(session.source, params, session.voice);
      session.generatedSeconds = result.generatedSeconds;
      const save = session.voice ? `/salvarvoz (guarda na voz "${session.voice}")` : '/salvarvoz <nome>';
      return { audio: result.audio, report: `${Mirror.report(session.source, result, params, changes, session.voice)}\n\nMais ajustes: /ajustar ... · Gostou? ${save}` };
    }
    const audio = await this.service.speak(session.text, session.voice, params);
    session.generatedSeconds = await this.mirror.duration(audio);
    return {
      audio,
      report: `🎚️ Ajuste: ${changes.join(', ')}\n🎛️ ${describeParams(params)}\n\nMais ajustes: /ajustar ... · Gostou? /salvarvoz para a voz "${session.voice}" usar isso sempre`,
    };
  }

  /** Guarda: no teste, a amostra vira voz nova (nome obrigatório); na fala, os ajustes vão para a voz usada. */
  save(key: string, name?: string): string {
    const session = this.session(key);
    const { seed: _seed, ...params } = session.params;
    if (session.kind === 'teste' && session.voice && !name?.trim()) {
      this.service.saveParams(session.voice, params);
      return `✅ Ajustes salvos na voz "${session.voice}" (${describeParams(params)}). O /falar com ela já usa isso.`;
    }
    if (session.kind === 'teste') {
      if (!name?.trim()) throw new UserFacingError('Dê um nome para a voz: /salvarvoz <nome>');
      const sample = this.service.saveVoice(name, session.source.reference, params);
      return `✅ Voz "${sample.name}" salva com a amostra do teste e os ajustes (${describeParams(params)}). Use: /falar @${sample.name} texto`;
    }
    const voice = name?.trim() ? this.service.resolveName(name) : session.voice;
    this.service.saveParams(voice, params);
    return `✅ Ajustes salvos na voz "${voice}" (${describeParams(params)}). O /falar com ela já usa isso.`;
  }

  private session(key: string): Session {
    const session = this.sessions.get(key);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(key);
      throw new UserFacingError('Nada para ajustar agora. Use /testarvoz (e envie um áudio) ou /falar <texto> primeiro.');
    }
    return session;
  }
}

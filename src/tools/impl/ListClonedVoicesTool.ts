import type { JsonSchema } from '../../llm/types.js';
import type { VoiceCloneService } from '../../voice/VoiceCloneService.js';
import { BaseTool, type ToolResult } from '../BaseTool.js';

export class ListClonedVoicesTool extends BaseTool {
  readonly name = 'listar_vozes_clonadas';
  readonly description = 'Lista as vozes clonadas disponíveis (amostras na pasta de vozes) e a voz padrão.';
  readonly parameters: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

  constructor(
    private readonly service: VoiceCloneService,
    private readonly defaultVoice: string | undefined,
  ) {
    super();
  }

  protected async run(): Promise<ToolResult> {
    const voices = this.service.list().map((voice) => voice.name);
    return {
      output: JSON.stringify({
        vozes: voices,
        padrao: this.defaultVoice || (voices.length === 1 ? voices[0] : null),
        dica: voices.length ? undefined : 'Nenhuma voz cadastrada: o usuário deve usar /minhavoz e enviar um áudio.',
      }),
    };
  }
}

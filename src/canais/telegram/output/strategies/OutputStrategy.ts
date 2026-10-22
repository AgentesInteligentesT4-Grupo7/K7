/** Strategy de saída: cada implementação sabe entregar um tipo de payload no chat. */
export interface IOutputStrategy<TPayload> {
  send(chatId: number, payload: TPayload): Promise<void>;
}

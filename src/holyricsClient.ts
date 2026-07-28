import { IHolyricsConnection } from './types';

/**
 * Cliente do API Server local do Holyrics — ver
 * https://github.com/holyrics/API-Server (README.md).
 * Convenção confirmada: POST http://[ip]:[porta]/api/{Acao}?token=abc,
 * Content-Type: application/json, corpo = parâmetros da ação.
 * Resposta: { status: "ok", data: ... } ou { status: "error", error: "..." }.
 */
export class HolyricsClient {
  constructor(private connection: IHolyricsConnection) {}

  async request<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const { ip, port, token } = this.connection;
    const url = `http://${ip}:${port}/api/${action}?token=${encodeURIComponent(token)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (err) {
      // Detalhe técnico só no console — pra quem está usando, o que importa é
      // saber que precisa checar se o Holyrics está aberto e na mesma rede.
      console.error(`Falha ao chamar ${action} no Holyrics:`, err);
      throw new Error('Não foi possível conectar ao Holyrics. Verifique se o programa está aberto e conectado na mesma rede.');
    }

    const body = await response.json().catch((): null => null);
    if (!body || body.status !== 'ok') {
      if (!body) console.error(`Resposta inválida do Holyrics em ${action}`);
      else console.error(`Erro do Holyrics em ${action}:`, body.error);
      throw new Error(body?.error || 'O Holyrics não conseguiu concluir essa ação.');
    }
    return body.data as T;
  }
}

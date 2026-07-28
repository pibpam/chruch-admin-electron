import { HolyricsClient } from '../holyricsClient';
import { state } from '../state';
import { IHealthcheckResult } from '../types';

/** Ver docs/integracao-holyrics.md seção 12. */
export async function statusConexao(): Promise<IHealthcheckResult> {
  if (!state.connection) {
    return { connected: false, error: 'Integração com o Holyrics ainda não foi configurada nesta sessão' };
  }

  const client = new HolyricsClient(state.connection);
  try {
    const [version, planInfo, apiInfo] = await Promise.all([
      client.request<{ version: string }>('GetVersion', {}),
      client.request<{ type: string }>('GetHolyricsPlanInfo', {}),
      client.request<{ enabled_local: boolean }>('GetAPIServerInfo', {}),
    ]);
    return {
      connected: true,
      version: version.version,
      planType: planInfo.type,
      apiEnabledLocal: apiInfo.enabled_local,
    };
  } catch (err) {
    return { connected: false, error: (err as Error).message };
  }
}

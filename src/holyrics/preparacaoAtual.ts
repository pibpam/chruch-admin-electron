import { BrowserWindow } from 'electron';
import { prepararEvento } from './prepare';
import { IPreparacaoStatus, IPrepararEventoParams, IPrepararEventoResult, IPrepararProgresso } from '../types';

/**
 * Uma preparação por vez. Fica guardada em memória do processo principal pra página recarregada
 * conseguir reconectar (statusPreparacao/aguardarPreparacao) e registrar o resultado no sistema
 * — o Electron nunca chama o backend, então o registro continua sendo da página.
 */
let atual: (IPreparacaoStatus & { promise: Promise<IPrepararEventoResult> }) | null = null;

const enviarProgresso = (progresso: IPrepararProgresso) => {
  // Manda pra todas as janelas, e não só pro event.sender de quem pediu: assim a página
  // recarregada no meio continua recebendo os passos.
  for (const janela of BrowserWindow.getAllWindows()) {
    if (!janela.webContents.isDestroyed()) janela.webContents.send('holyrics:preparar:progresso', progresso);
  }
};

export function iniciarPreparacao(params: IPrepararEventoParams): Promise<IPrepararEventoResult> {
  if (atual?.status === 'running') {
    if (atual.planUuid === params.planUuid) return atual.promise;
    throw new Error('Já existe uma preparação em andamento para outro plano. Aguarde ela terminar.');
  }

  const job: NonNullable<typeof atual> = {
    planUuid: params.planUuid,
    startedAt: Date.now(),
    status: 'running',
    progresso: [],
    promise: Promise.resolve(null as unknown as IPrepararEventoResult),
  };

  job.promise = prepararEvento(params, (progresso) => {
    const index = job.progresso.findIndex((item) => item.key === progresso.key);
    if (index === -1) job.progresso.push(progresso);
    else job.progresso[index] = progresso;
    enviarProgresso(progresso);
  }).then(
    (result) => {
      job.status = 'done';
      job.result = result;
      return result;
    },
    (error) => {
      job.status = 'error';
      job.error = String(error?.message || error);
      throw error;
    },
  );

  // Se a página recarregou, ninguém mais espera essa promise — sem isso o erro vira
  // unhandled rejection no processo principal (ele continua guardado em job.error).
  job.promise.catch((): void => undefined);
  atual = job;
  return job.promise;
}

export function statusPreparacao(): IPreparacaoStatus | null {
  if (!atual) return null;
  const { planUuid, startedAt, status, progresso, result, error } = atual;
  return { planUuid, startedAt, status, progresso, result, error };
}

/** Espera a preparação corrente; se já terminou, devolve o resultado (ou o erro) guardado. */
export async function aguardarPreparacao(): Promise<IPrepararEventoResult> {
  if (!atual) throw new Error('Nenhuma preparação em andamento.');
  return atual.promise;
}

/** A página registrou o resultado — esquece o job pra não reprocessar no próximo carregamento. */
export function descartarPreparacao(planUuid: string): void {
  if (atual && atual.planUuid === planUuid && atual.status !== 'running') atual = null;
}

import { handleApi, type EdgeEnv } from '../../src/edge';

export const onRequest = (context: { request: Request; env: EdgeEnv }): Promise<Response> =>
  handleApi(context.request, context.env);

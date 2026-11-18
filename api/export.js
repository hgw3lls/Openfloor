import {databaseUrl, postgres} from '../lib/db.mjs';
import {exportData} from '../lib/export.mjs';

export default {
  async fetch(request) {
    const url = databaseUrl();
    if (!url) return Response.json({error: 'Not configured.'}, {status: 503});
    try { return await exportData(request, postgres(url)); }
    catch (error) {
      console.error('Export failed', error.code ?? error.name);
      return Response.json({error: 'Something went wrong.'}, {status: 500});
    }
  }
};

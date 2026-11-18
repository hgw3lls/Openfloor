import {neon} from '@neondatabase/serverless';
import {meetings} from '../lib/meetings.mjs';

function postgres(connectionString) {
  const sql = neon(connectionString, {fullResults: true});
  return {
    prepare(statement) {
      let parameter = 0;
      const query = statement.replaceAll('?', () => '$' + ++parameter);
      return {
        bind(...values) {
          const execute = () => sql.query(query, values);
          return {
            first: async () => (await execute()).rows[0],
            all: async () => ({results: (await execute()).rows}),
            run: async () => ({meta: {changes: (await execute()).rowCount}})
          };
        }
      };
    }
  };
}

export default {
  async fetch(request) {
    const {DATABASE_URL, ORGANIZER_KEY} = process.env;
    if (!DATABASE_URL || !ORGANIZER_KEY?.trim()) {
      return Response.json({error:'The meeting board has not been configured yet.'}, {status:503});
    }
    try {
      return await meetings(request, postgres(DATABASE_URL), ORGANIZER_KEY.trim());
    } catch (error) {
      console.error('Meeting request failed', error.code ?? error.name);
      return Response.json({error:'Something went wrong. Try again.'}, {status:500, headers:{'Cache-Control':'no-store'}});
    }
  }
};

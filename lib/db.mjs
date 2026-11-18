import {neon} from '@neondatabase/serverless';

export const databaseUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL;

// Small prepare/bind wrapper so queries can use ? placeholders.
export function wrap(query) {
  return {
    prepare(statement) {
      let parameter = 0;
      const text = statement.replaceAll('?', () => '$' + ++parameter);
      return {
        bind(...values) {
          const execute = () => query(text, values);
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

export function postgres(connectionString) {
  const sql = neon(connectionString, {fullResults: true});
  return wrap((text, values) => sql.query(text, values));
}

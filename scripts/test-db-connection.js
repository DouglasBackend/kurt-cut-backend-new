import postgres from 'postgres';

const sql = postgres({
  host: 'aws-1-sa-east-1.pooler.supabase.com',
  port: 5432,
  database: 'postgres',
  username: 'postgres.ifrgvzauyihjjnsnfrdi',
  password: 'Kurtcut@2025',
  ssl: { rejectUnauthorized: false },
});

async function testConnection() {
  try {
    const result = await sql`SELECT NOW()`;
    console.log('✅ Connection successful!');
    console.log('Current time:', result[0].now);
  } catch (error) {
    console.error('❌ Connection failed:', error);
  }
}

testConnection();

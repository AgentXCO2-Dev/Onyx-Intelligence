import express from 'express';
import cors from 'cors';
import { Mistral } from '@mistralai/mistralai';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.chat.stream({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: message }],
    });

    for await (const chunk of stream) {
      const content = chunk.data.choices[0]?.delta?.content;
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Mistral Error:', error);
    res.write(`data: ${JSON.stringify({ error: 'AI service error' })}\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`🖤 Onyx AI backend running on port ${port}`);
});

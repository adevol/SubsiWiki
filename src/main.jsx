import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8787';

function linkifyCitations(text, sources) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, idx) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (!m) return part.split('\n').map((line, i, arr) => <React.Fragment key={`${idx}-${i}`}>{line}{i < arr.length - 1 ? <br /> : null}</React.Fragment>);
    const source = sources.find(s => s.id === Number(m[1]));
    if (!source) return <span key={idx}>{part}</span>;
    return <a key={idx} className="citation" href={source.url || '#sources'} target={source.url ? '_blank' : undefined} rel="noreferrer">{part}</a>;
  });
}

function App() {
  const [question, setQuestion] = useState('What funding could a Marseille manufacturer using shells and scent innovation qualify for?');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [usedLLM, setUsedLLM] = useState(null);
  const [allowWeb, setAllowWeb] = useState(false);
  const [checkSources, setCheckSources] = useState(false);
  const [sourceCheck, setSourceCheck] = useState(null);
  const [trace, setTrace] = useState([]);

  const suggestions = useMemo(() => [
    'What types of funding could a small manufacturer qualify for?',
    'How do I apply for EU funding and what are the steps?',
    'Which programmes support circular economy or green products?',
    'What is the difference between grants, subsidies, loans, and tenders?',
  ], []);

  async function submit(e) {
    e?.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError('');
    setAnswer('');
    setSources([]);
    setSourceCheck(null);
    setTrace([]);
    try {
      const res = await fetch(`${API}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, allowWeb, checkSources })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setAnswer(json.answer);
      setSources(json.sources || []);
      setUsedLLM(json.usedLLM);
      setSourceCheck(json.sourceCheck || null);
      setTrace(json.trace || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return <div className="app">
    <div className="glow glow-one" />
    <div className="glow glow-two" />

    <header className="hero">
      <div className="eyebrow">SubsiWiki AI</div>
      <h1>Ask the EU funding knowledge base.</h1>
      <p>Get practical answers from your Obsidian vault with clickable citations, and add live web search snippets when you approve it.</p>
    </header>

    <main className="panel">
      <form onSubmit={submit} className="ask-box">
        <label htmlFor="question">Your question</label>
        <textarea id="question" value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask about grants, SME funding, green innovation, application steps..." />
        <div className="actions">
          <button disabled={loading}>{loading ? 'Asking...' : 'Ask SubsiWiki'}</button>
          <label className="toggle">
            <input type="checkbox" checked={allowWeb} onChange={e => setAllowWeb(e.target.checked)} />
            <span>Allow live web</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={checkSources} onChange={e => setCheckSources(e.target.checked)} />
            <span>Check sources</span>
          </label>
          <span className="status">{usedLLM === false ? 'Retrieval-only: add OPENROUTER_API_KEY for generated answers' : usedLLM === true ? 'LLM answer generated from retrieved sources' : 'Cited answers from your vault'}</span>
        </div>
      </form>

      <div className="chips">
        {suggestions.map(s => <button key={s} onClick={() => setQuestion(s)} type="button">{s}</button>)}
      </div>

      {error && <div className="error">{error}</div>}

      {answer && <section className="answer-card">
        <h2>Answer</h2>
        <div className="answer-text">{linkifyCitations(answer, sources)}</div>
      </section>}

      {sourceCheck && <section className={`source-check-card source-check-${sourceCheck.status}`}>
        <h2>Source check</h2>
        <div className="source-check-summary">
          <strong>{sourceCheck.status}</strong>
          <span>{sourceCheck.summary}</span>
        </div>
        {!!sourceCheck.missingCitationIds?.length && <p>Missing citations: {sourceCheck.missingCitationIds.map(id => `[${id}]`).join(' ')}</p>}
        {!!sourceCheck.issues?.length && <ul>
          {sourceCheck.issues.map(issue => <li key={issue}>{issue}</li>)}
        </ul>}
      </section>}

      {!!trace.length && <section className="trace-card">
        <h2>Research trace</h2>
        <div className="trace-list">
          {trace.map((step, idx) => <div key={`${step.tool}-${idx}`} className="trace-item">
            <strong>{step.tool.replaceAll('_', ' ')}</strong>
            <span>{step.input}</span>
            {!!step.sources?.length && <em>{step.sources.map(id => `[${id}]`).join(' ')}</em>}
            {step.error && <em>{step.error}</em>}
          </div>)}
        </div>
      </section>}

      {!!sources.length && <section id="sources" className="sources-card">
        <h2>Cited sources</h2>
        <div className="sources-list">
          {sources.map(source => <article key={source.id} className="source-item">
            <div className="source-num">[{source.id}]</div>
            <div>
              <h3>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</h3>
              <p className="source-meta">{source.sourceType || source.kind} · {source.url || source.path}</p>
              {!!source.relatedUrls?.length && <p className="related-links">Official links: {source.relatedUrls.map((url, i) => <React.Fragment key={url}><a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname}</a>{i < source.relatedUrls.length - 1 ? ', ' : ''}</React.Fragment>)}</p>}
              {source.excerpts?.[0] && <blockquote>{source.excerpts[0]}...</blockquote>}
            </div>
          </article>)}
        </div>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);

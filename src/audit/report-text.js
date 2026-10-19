/**
 * Человекочитаемый вывод комплексного аудита в консоль.
 */

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
};

const SEVERITY_MARKS = { critical: '[!]', warning: '[~]', info: '[i]' };

function printAuditReport(result) {
  const line = '-'.repeat(70);
  console.log(`\n${line}`);
  console.log('  OWA — Комплексный аудит сайта');
  console.log(`  URL: ${result.url}`);
  console.log(`  Дата: ${result.timestamp}`);
  console.log(line);

  console.log('\n■ Оценки по секциям');
  for (const [name, sec] of Object.entries(result.scores)) {
    const label = SECTION_LABELS[name] || name;
    const score = sec.score === null ? 'n/a' : `${sec.score}/100`;
    const time = sec.durationMs !== null && sec.durationMs !== undefined ? `, ${sec.durationMs} мс` : '';
    console.log(`  ${label}: ${score} [${sec.status}${time}]`);
  }
  console.log(`\n  Интегральная оценка: ${result.integralScore}/100`);
  if (result.failedSections.length) {
    console.log(`  Не удалось получить секции: ${result.failedSections.join(', ')}`);
  }

  console.log('\n■ Проблемы по приоритету');
  const sorted = [...result.issues].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });
  if (!sorted.length) {
    console.log('  Критичных проблем не обнаружено.');
  }
  for (const i of sorted) {
    const mark = SEVERITY_MARKS[i.severity] || '[-]';
    console.log(`  ${mark} ${i.message}`);
    if (i.recommendation) console.log(`      -> ${i.recommendation}`);
  }
  console.log(`\n${line}\n`);
}

module.exports = { printAuditReport, SECTION_LABELS };
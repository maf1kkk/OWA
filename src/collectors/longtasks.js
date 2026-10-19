/**
 * Сбор Long Tasks (>50 мс) через PerformanceObserver.
 * Ставится ДО навигации (addInitScript), буфер копится в window.__owaLongTasks.
 */
module.exports = {
  initScript: `
    window.__owaLongTasks = [];
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__owaLongTasks.push({
            startTime: Math.round(e.startTime),
            duration: Math.round(e.duration),
            attribution: (e.attribution || []).map((a) => ({
              name: a.name,
              containerType: a.containerType,
              containerSrc: a.containerSrc,
              containerId: a.containerId,
              containerName: a.containerName,
            })),
          });
        }
      });
      // buffered: true — отдаёт и те задачи, что уже записаны до подписки.
      // Без этого long task, случившийся во время парсинга, терялся: отчёт
      // зависел от того, успел ли колбэк сработать (нестабильная форма JSON).
      po.observe({ entryTypes: ['longtask'], buffered: true });
    } catch (e) {
      window.__owaLongTasksUnsupported = true;
    }
  `,
  collectScript: `(() => {
    const tasks = window.__owaLongTasks || [];
    const max = tasks.reduce((m, t) => Math.max(m, t.duration), 0);
    const totalBlocking = tasks.reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
    return {
      supported: !window.__owaLongTasksUnsupported,
      count: tasks.length,
      maxDuration: max,
      totalBlockingTime: totalBlocking,
      tasks: tasks.slice(0, 20),
    };
  })()`,

  /**
   * Форсирует доставку записей PerformanceObserver.
   *
   * Наблюдатели (longtask, LCP, layout-shift) отдают записи на шаге
   * рендеринга. Если страница после load больше не рисует (типично для
   * статики в headless), колбэк может не вызваться вовсе — метрика молча
   * пропадала, а форма отчёта «плавала» между прогонами. Два кадра + пауза
   * гарантируют, что очередь наблюдателя разобрана до сбора метрик.
   */
  flushScript: `(async () => {
    await new Promise((r) => requestAnimationFrame(() => r()));
    await new Promise((r) => setTimeout(r, 60));
    await new Promise((r) => requestAnimationFrame(() => r()));
    return true;
  })()`,
};

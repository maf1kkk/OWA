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
      po.observe({ entryTypes: ['longtask'] });
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
};

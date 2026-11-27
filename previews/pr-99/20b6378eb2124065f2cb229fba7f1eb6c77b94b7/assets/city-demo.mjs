// The city is a simulation. Each activation advances one step on the same snapshot.
const jobs = ['school', 'train', 'utility'];
const statusNames = { queued: 'Waiting', running: 'Running', done: 'Complete' };
const steps = [
  { raised: false, states: ['queued', 'queued', 'queued'], text: 'The workers are ready to read one city snapshot.' },
  { raised: true, states: ['running', 'queued', 'queued'], text: 'The proposed district rises. The first worker estimates school demand.' },
  { raised: true, states: ['running', 'running', 'running'], text: 'All three workers now read the same snapshot to check schools, trains, and utilities.' },
  { raised: true, states: ['done', 'running', 'running'], text: 'The school estimate is complete. The other two workers continue reading.' },
  { raised: true, states: ['done', 'done', 'done'], text: 'All three jobs have finished reading this snapshot.' },
];

export function setupCityDemo(details) {
  const template = details.querySelector('template');
  function openDemo() {
    if (!details.open) return;
    // Template contents are inert, including responsive image sources, until opened.
    template.replaceWith(template.content.cloneNode(true));
    details.removeEventListener('toggle', openDemo);
    const figure = details.querySelector('.city-example');
    const next = details.querySelector('button');
    const status = details.querySelector('[role="status"]');
    let index = 0;
    next.addEventListener('click', () => {
      index = (index + 1) % steps.length;
      const step = steps[index];
      figure.dataset.district = step.raised ? 'raised' : 'planned';
      for (const node of figure.querySelectorAll('[data-job]')) {
        const state = step.states[jobs.indexOf(node.dataset.job)];
        node.dataset.state = state;
        const label = node.querySelector('.job-status');
        if (label) label.textContent = statusNames[state];
      }
      status.textContent = step.text;
      next.textContent = index === steps.length - 1 ? 'Restart demo' : 'Next step';
    });
  }
  details.addEventListener('toggle', openDemo);
  openDemo();
}

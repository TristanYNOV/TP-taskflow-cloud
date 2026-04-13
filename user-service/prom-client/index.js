class Registry {
  constructor() {
    this.contentType = 'text/plain; version=0.0.4; charset=utf-8';
    this._metrics = [];
  }

  registerMetric(metric) {
    this._metrics.push(metric);
  }

  async metrics() {
    return this._metrics.map((metric) => metric.toProm()).join('\n');
  }
}

class BaseMetric {
  constructor({ name, help, labelNames = [] }) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map();
  }

  _key(labels = {}) {
    return this.labelNames.map((name) => `${name}:${labels[name] ?? ''}`).join('|');
  }

  _labelsText(labels = {}) {
    if (!this.labelNames.length) return '';
    const pairs = this.labelNames
      .filter((name) => labels[name] !== undefined)
      .map((name) => `${name}="${String(labels[name]).replace(/"/g, '\\"')}"`);
    return pairs.length ? `{${pairs.join(',')}}` : '';
  }
}

class Counter extends BaseMetric {
  inc(labels = {}, value = 1) {
    const key = this._key(labels);
    const current = this.values.get(key) ?? { labels, value: 0 };
    current.value += value;
    this.values.set(key, current);
  }

  toProm() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines.join('\n');
    }

    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${this._labelsText(labels)} ${value}`);
    }

    return lines.join('\n');
  }
}

class Histogram extends BaseMetric {
  observe(labels = {}, value = 0) {
    const key = this._key(labels);
    const current = this.values.get(key) ?? { labels, sum: 0, count: 0 };
    current.sum += value;
    current.count += 1;
    this.values.set(key, current);
  }

  toProm() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    if (this.values.size === 0) {
      lines.push(`${this.name}_count 0`);
      lines.push(`${this.name}_sum 0`);
      return lines.join('\n');
    }

    for (const { labels, sum, count } of this.values.values()) {
      const labelText = this._labelsText(labels);
      lines.push(`${this.name}_count${labelText} ${count}`);
      lines.push(`${this.name}_sum${labelText} ${sum}`);
    }

    return lines.join('\n');
  }
}

function collectDefaultMetrics() {
  return undefined;
}

module.exports = {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
};

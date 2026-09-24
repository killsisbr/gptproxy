module.exports = {
  apps: [
    {
      name: 'gptproxy',
      cwd: '/root/killsis/gptproxy',
      script: '/usr/bin/xvfb-run',
      args: '-a bun src/index.ts --headed',
      interpreter: 'none',
      env: {
        NODE_ENV: 'production',
        PORT: '3333',
        HEADED: '1',
        GPT_PROXY_HEADED: '1',
      },
    },
  ],
};

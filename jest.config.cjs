/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'shared',
      preset: 'ts-jest/presets/default-esm',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/shared/**/*.test.ts'],
      extensionsToTreatAsEsm: ['.ts'],
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { useESM: true, tsconfig: '<rootDir>/shared/tsconfig.json' },
        ],
      },
    },
    {
      displayName: 'client',
      preset: 'ts-jest/presets/default-esm',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/client/**/*.test.ts', '<rootDir>/client/**/*.test.tsx'],
      extensionsToTreatAsEsm: ['.ts', '.tsx'],
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@hivemind/shared$': '<rootDir>/shared/src/index.ts',
        '\\.(css|less|scss)$': '<rootDir>/__tests__/styleMock.cjs',
      },
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { useESM: true, tsconfig: '<rootDir>/client/tsconfig.json' },
        ],
      },
    },
    {
      displayName: 'server',
      preset: 'ts-jest/presets/default-esm',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/server/**/*.test.ts'],
      extensionsToTreatAsEsm: ['.ts'],
      moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^@hivemind/shared$': '<rootDir>/shared/src/index.ts',
      },
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          { useESM: true, tsconfig: '<rootDir>/server/tsconfig.json' },
        ],
      },
    },
  ],
};

"""Point storage at a throwaway SQLite file before it's imported, so tests
never touch a real database."""
import os
import tempfile

os.environ['DUTCH_DB'] = os.path.join(tempfile.mkdtemp(prefix='dutch-test-'), 'test.db')

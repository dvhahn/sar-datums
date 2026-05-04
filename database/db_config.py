import os
import psycopg2
from dotenv import load_dotenv

# Load the variables from .env file
load_dotenv()


def get_connection(target="local"):
    if target == "aws":
        return psycopg2.connect(
            dbname=os.getenv("AWS_DB_NAME", "sar-datums-application"),
            user=os.getenv("AWS_DB_USER", "postgres"),
            password=os.getenv("AWS_DB_PASSWORD"),
            host=os.getenv("AWS_DB_HOST"),
            port=os.getenv("AWS_DB_PORT", "5432"),
            sslmode="require"
        )

    return psycopg2.connect(
        dbname=os.getenv("DB_NAME", "sar_datums"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
        host=os.getenv("DB_HOST", "localhost")
    )

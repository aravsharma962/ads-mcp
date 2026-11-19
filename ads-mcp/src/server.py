"""Lesson 1: hello-world MCP server (stdio).

Maqsad: sirf yeh dekhna ki Claude humare Python function ko "tool" ki tarah call kar paata hai.
Ads API abhi nahi, woh Lesson 3 mein.
"""
from mcp.server.fastmcp import FastMCP

# Server ka naam. Claude ko yahi naam dikhta hai.
mcp = FastMCP("ads-manager")


@mcp.tool()
def ping() -> str:
    """Check karta hai ki server zinda hai. Hamesha 'pong' lautata hai."""
    # Yeh docstring zaroori hai: Claude isi se samajhta hai ki tool kab use karna hai.
    return "pong"


@mcp.tool()
def add(a: float, b: float) -> float:
    """Do numbers ka jod. Type hints (a: float) se Claude ko input ka schema milta hai."""
    return a + b


if __name__ == "__main__":
    # stdio = Claude Desktop is process ko apne computer par chalata hai.
    mcp.run()

//! sendblob companion CLI: provide/download from the terminal.

use anyhow::Result;
use bytes::Bytes;
use clap::{Parser, Subcommand};
use iroh_blobs::ticket::BlobTicket;
use sendblob::node::BlobsNode;

#[derive(Parser)]
#[command(name = "sendblob", version, about = "sendblob CLI companion")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve a file and print the transfer ticket
    Provide {
        /// Path of the file to share
        path: String,
    },
    /// Download a blob from a ticket
    Download {
        /// Ticket produced by the sender
        ticket: String,
        /// Optional output path
        #[arg(short, long)]
        out: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Provide { path } => {
            let node = BlobsNode::spawn().await?;
            let data = tokio::fs::read(&path).await?;
            let ticket = node.import(Bytes::from(data)).await?;
            println!("⚡ Ticket: {ticket}");
            println!("Sharing — Ctrl-C to stop.");
            tokio::signal::ctrl_c().await?;
        }
        Command::Download { ticket, out } => {
            let node = BlobsNode::spawn().await?;
            let ticket: BlobTicket = ticket.parse()?;
            println!("⏳ Downloading…");
            let hash = node.download(ticket).await?;
            let size = node.complete_size(hash).await?;
            let bytes = node.get_bytes(hash).await?;
            let out = out.unwrap_or_else(|| format!("{hash}.bin"));
            tokio::fs::write(&out, &bytes).await?;
            println!("✅ {size} bytes written to {out}");
        }
    }
    Ok(())
}

//! CLI compagnon sendblob : provide/download depuis le terminal.

use anyhow::Result;
use bytes::Bytes;
use clap::{Parser, Subcommand};
use sendblob::node::BlobsNode;
use iroh_blobs::ticket::BlobTicket;

#[derive(Parser)]
#[command(name = "sendblob", version, about = "sendblob CLI companion")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Offrir un fichier et afficher le ticket de transfert
    Provide {
        /// Chemin du fichier à partager
        path: String,
    },
    /// Télécharger un blob depuis un ticket
    Download {
        /// Ticket produit par l'expéditeur
        ticket: String,
        /// Chemin de sortie optionnel
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
            println!("Partage en cours — Ctrl-C pour arrêter.");
            tokio::signal::ctrl_c().await?;
        }
        Command::Download { ticket, out } => {
            let node = BlobsNode::spawn().await?;
            let ticket: BlobTicket = ticket.parse()?;
            println!("⏳ Téléchargement…");
            let hash = node.download(ticket).await?;
            let size = node.complete_size(hash).await?;
            let bytes = node.get_bytes(hash).await?;
            let out = out.unwrap_or_else(|| format!("{hash}.bin"));
            tokio::fs::write(&out, &bytes).await?;
            println!("✅ {size} octets écrits dans {out}");
        }
    }
    Ok(())
}
